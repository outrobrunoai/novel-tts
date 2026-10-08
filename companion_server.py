#!/usr/bin/env python3
"""Authenticated local cache. Python standard library, loopback only."""
import hashlib
import hmac
import http.client
import io
import json
import math
import os
import re
import socket
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from nlr_config import (active_profile, identity, option, read_config, requires_mount,
                        resolve_voice, validate, voice_names)

MAX_BODY = 64 * 1024
MAX_AUDIO = 32 * 1024 * 1024
# Entries are named by cache_key(); nothing else in cache_dir belongs to us.
CACHE_ENTRY = re.compile(r'[0-9a-f]{64}\.wav')
APP_VERSION = '1.0.0'
SERVICE_VERSION = APP_VERSION
PROTOCOL_CURRENT = 1
PROTOCOL_MINIMUM = 1
PROTOCOL_MAXIMUM = 1

ERRORS = {
    'AUTH_REQUIRED': (401, False, 'Pareamento necessário. Abra Conexão na extensão.'),
    'HOST_FORBIDDEN': (403, False, 'Host recusado.'),
    'ORIGIN_FORBIDDEN': (403, False, 'Origem recusada.'),
    'INVALID_REQUEST': (400, False, 'Solicitação inválida.'),
    'BODY_TOO_LARGE': (413, False, 'Corpo excede o limite aceito.'),
    'UNSUPPORTED_MEDIA_TYPE': (415, False, 'Use application/json.'),
    'ENDPOINT_NOT_FOUND': (404, False, 'Endpoint inexistente.'),
    'VOICE_NOT_FOUND': (400, False, 'Voz solicitada não existe.'),
    'QUEUE_FULL': (429, False, 'Fila local cheia. Aguarde.'),
    'UPSTREAM_UNAVAILABLE': (502, True, 'Qwen3-TTS indisponível.'),
    'UPSTREAM_TIMEOUT': (504, True, 'Qwen3-TTS excedeu o tempo limite.'),
    'UPSTREAM_REJECTED': (502, False, 'Qwen3-TTS recusou a solicitação.'),
    'INVALID_AUDIO': (502, False, 'Qwen3-TTS retornou áudio inválido.'),
    'CACHE_UNAVAILABLE': (503, False, 'Cache local indisponível.'),
    'PROTOCOL_INCOMPATIBLE': (426, False, 'Protocolo incompatível.'),
    'INTERNAL_ERROR': (500, False, 'Falha interna do serviço.'),
}

def protocol_info():
    return dict(current=PROTOCOL_CURRENT, minimum=PROTOCOL_MINIMUM,
                maximum=PROTOCOL_MAXIMUM)

def error_payload(code, message=None):
    status, retryable, default = ERRORS[code]
    return status, dict(error=dict(code=code, message=message or default,
                                   retryable=retryable))

def canonical_request(payload):
    if not isinstance(payload, dict):
        raise ValueError('JSON deve ser um objeto.')
    text = payload.get('input')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError('Texto deve ter de 1 a 4000 caracteres.')
    voice = payload.get('voice', '')
    if not isinstance(voice, str) or len(voice) > 255:
        raise ValueError('Voz inválida.')
    temperature = payload.get('temperature', .9)
    seed = payload.get('seed', 42)
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or not 0 <= temperature <= 2:
        raise ValueError('Temperatura inválida.')
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError('Seed inválida.')
    instructions = payload.get('instructions', '')
    if not isinstance(instructions, str) or len(instructions) > 500:
        raise ValueError('Instruções inválidas.')
    # The installed checkpoint is Qwen3-TTS Base. It clones voices but rejects
    # style instructions, so they are validated and intentionally omitted from
    # both the upstream request and cache identity.
    return dict(input=text, voice=voice, temperature=temperature, seed=seed,
                instructions='', response_format='wav')

def canonical_warm_request(payload):
    """The warm endpoint has no use for output or style controls.

    Keeping this separate makes accidental forwarding of a future speech-only
    field impossible while preserving the exact cache identity for the fields
    that do affect Qwen output.
    """
    if not isinstance(payload, dict) or set(payload) - {'input', 'voice', 'temperature', 'seed'}:
        raise ValueError('Campos de warm-cache inválidos.')
    return canonical_request(payload)


def upstream_payload(config, payload):
    return dict(input=payload['input'], voice=resolve_voice(config, payload['voice']),
                temperature=payload['temperature'], seed=payload['seed'],
                response_format='wav')

def cache_key(payload, fingerprint):
    return hashlib.sha256(json.dumps([2, fingerprint, payload], sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def validate_wav(data):
    if len(data) > MAX_AUDIO:
        raise ValueError('Áudio excede o limite de 32 MiB.')
    try:
        with wave.open(io.BytesIO(data)) as wav:
            if wav.getnchannels() not in (1, 2) or not 8000 <= wav.getframerate() <= 96000 or wav.getnframes() == 0:
                raise ValueError('WAV inválido ou vazio.')
            expected = wav.getnframes() * wav.getnchannels() * wav.getsampwidth()
            if expected > MAX_AUDIO or len(wav.readframes(wav.getnframes())) != expected:
                raise ValueError('WAV incompleto.')
            return wav.getnframes() / wav.getframerate()
    except EOFError as error:  # a body too short to hold even a WAV header
        raise ValueError('WAV incompleto.') from error

def configured_upstream(config):
    profile = active_profile(config)
    return f"http://{option(profile['argv'], '--host')}:{option(profile['argv'], '--port')}"


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, config, upstream=None, check_mount=True, idle_timeout=120):
        self.config = config
        self.upstream = upstream or configured_upstream(config)
        self.check_mount = check_mount
        self.idle_timeout = idle_timeout
        self.disk_lock = threading.RLock()
        self.generation_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(8)
        self.epoch = 0
        super().__init__(address, Handler)

    def directory(self):
        if self.check_mount and requires_mount(self.config) and not Path(self.config['data_root']).is_mount():
            # OSError, not ValueError: every handler maps it to CACHE_UNAVAILABLE.
            raise OSError('HD indisponível. Cache não será criado na raiz.')
        directory = Path(self.config['cache_dir'])
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return directory

    def verified(self, target, data):
        # Returns the bytes when they are a complete WAV, otherwise removes the
        # file and returns None so the caller regenerates it.
        if data is None:
            return None
        try:
            validate_wav(data)
            return data
        except (ValueError, EOFError, wave.Error, OSError) as error:
            print('[nlr] cache entry descartado:', error, flush=True)
            with self.disk_lock:
                target.unlink(missing_ok=True)
            return None

    def entries(self):
        """Cache files this service created; never a user's unrelated WAV."""
        return [path for path in self.directory().glob('*.wav')
                if CACHE_ENTRY.fullmatch(path.name) and not path.is_symlink() and path.is_file()]

    def stats(self):
        with self.disk_lock:
            files = self.entries()
            return dict(count=len(files), bytes=sum(p.stat().st_size for p in files))

    def prune(self, preserve):
        # Called under disk_lock. Keep the audio currently being returned.
        files = sorted(self.entries(), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        limit = max(100, min(50000, int(self.config['cache_limit_mb']))) * 1024**2
        for path in files:
            if total <= limit: break
            if path == preserve: continue
            total -= path.stat().st_size
            path.unlink(missing_ok=True)

class Handler(BaseHTTPRequestHandler):
    server_version = 'NovelTTS/1.0'
    # Keep-alive: one TCP connection serves a whole chapter instead of one per
    # paragraph. Every response path below sends Content-Length, and the paths
    # that skip the request body set close_connection so nothing is left unread.
    protocol_version = 'HTTP/1.1'

    def setup(self):
        # An idle keep-alive (or deliberately slow) client must not pin a
        # handler thread forever; BaseHTTPRequestHandler closes on timeout.
        self.timeout = self.server.idle_timeout
        super().setup()

    def handle_one_request(self):
        self.responded = False
        super().handle_one_request()

    def log_message(self, fmt, *args):
        # No text, token, headers or filesystem paths in access logs.
        print('[nlr]', fmt % args, flush=True)

    def end_headers(self):
        # HTTP/1.1 keeps the socket open by default, so a response that skipped
        # the request body has to say so explicitly or the next request on this
        # connection would read the leftover bytes as its request line.
        if self.close_connection:
            self.send_header('Connection', 'close')
        origin = self.headers.get('Origin', '')
        if origin.startswith('moz-extension://'):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def authorized(self):
        origin = self.headers.get('Origin', '')
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
            self.reply_error('HOST_FORBIDDEN')
            return False
        if origin and not origin.startswith('moz-extension://'):
            self.reply_error('ORIGIN_FORBIDDEN')
            return False
        expected = 'Bearer ' + self.server.config['token']
        if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), expected.encode()):
            self.reply_error('AUTH_REQUIRED')
            return False
        return True

    def do_OPTIONS(self):
        origin = self.headers.get('Origin', '')
        allowed = origin.startswith('moz-extension://')
        self.responded = True
        self.send_response(204 if allowed else 403)
        if not allowed: self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self.authorized(): return
        try:
            if self.path == '/health':
                upstream = False
                for endpoint in ('/v1/audio/voices', '/v1/models', '/health'):
                    try:
                        with urllib.request.urlopen(self.server.upstream + endpoint, timeout=2) as response:
                            upstream = response.status == 200
                        if upstream: break
                    except (OSError, ValueError): pass
                self.reply(200, dict(status='ok', upstream=upstream, backend='qwen3',
                                    mode=self.server.config['mode'], version=APP_VERSION,
                                    service_version=SERVICE_VERSION, protocol=protocol_info(),
                                    cache_limit_mb=self.server.config['cache_limit_mb'],
                                    generation_busy=self.server.generation_lock.locked(),
                                    fingerprint=identity(self.server.config), **self.server.stats()))
            elif self.path == '/identity':
                self.reply(200, dict(fingerprint=identity(self.server.config), mode=self.server.config['mode']))
            elif self.path == '/voices':
                self.reply(200, dict(voices=voice_names(self.server.config),
                                     default_voice=resolve_voice(self.server.config)))
            elif self.path == '/v1/nlr/capabilities':
                self.reply(200, dict(service_version=SERVICE_VERSION, protocol=protocol_info(),
                    backend=dict(name='qwen3', variant='base'), capabilities=dict(
                        voice_cloning=True, multiple_voices=len(voice_names(self.server.config)) > 1,
                        deterministic_seed=True, temperature=True, style_instructions=False,
                        cache_warming=True, offline_cache_hits=True)))
            elif self.path == '/cache/stats': self.reply(200, self.server.stats())
            else: self.reply_error('ENDPOINT_NOT_FOUND')
        except (OSError, ValueError): self.reply_error('CACHE_UNAVAILABLE')

    def do_DELETE(self):
        if not self.authorized(): return
        if self.path != '/cache':
            self.reply_error('ENDPOINT_NOT_FOUND')
            return
        try:
            with self.server.disk_lock:
                self.server.epoch += 1
                for path in self.server.entries(): path.unlink(missing_ok=True)
            self.reply(200, {'ok': True})
        except (OSError, ValueError): self.reply_error('CACHE_UNAVAILABLE')

    def do_POST(self):
        if not self.authorized(): return
        warm = self.path == '/v1/nlr/cache/warm'
        if not warm and self.path != '/v1/audio/speech':
            self.reply_error('ENDPOINT_NOT_FOUND')
            return
        if self.headers.get_content_type() != 'application/json':
            self.reply_error('UNSUPPORTED_MEDIA_TYPE')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                self.reply_error('BODY_TOO_LARGE')
                return
            # Bound only the body read. Restoring the timeout afterwards keeps it
            # from also governing the response write, which may carry 32 MiB.
            previous_timeout = self.connection.gettimeout()
            self.connection.settimeout(15)
            try: body = self.rfile.read(length)
            finally: self.connection.settimeout(previous_timeout)
            payload = (canonical_warm_request if warm else canonical_request)(json.loads(body))
        except (ValueError, OSError, RecursionError):
            # json.loads raises RecursionError for deeply nested input.
            self.reply_error('INVALID_REQUEST')
            return
        try:
            fingerprint = identity(self.server.config, payload['voice'])
        except ValueError:
            self.reply_error('VOICE_NOT_FOUND')
            return
        except OSError:
            self.reply_error('CACHE_UNAVAILABLE')
            return
        try:
            result = self.generate_cached_audio(payload, fingerprint)
            if warm:
                # The endpoint deliberately exposes only fixed-size metadata.
                self.reply(200, dict(status='ready', cached=result['cached'],
                    duration=round(result['duration'], 3), elapsed=round(result['elapsed'], 3),
                    fingerprint=fingerprint))
                return
            data = result['data']
            self.responded = True
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-NLR-Cache', 'HIT' if result['cached'] else 'MISS')
            self.send_header('X-NLR-Identity', fingerprint)
            self.send_header('X-NLR-Duration', str(round(result['duration'], 3)))
            self.send_header('X-NLR-Elapsed', str(round(result['elapsed'], 3)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as error:
            self.fail('UPSTREAM_REJECTED', error)
        except (socket.timeout, TimeoutError) as error:
            self.fail('UPSTREAM_TIMEOUT', error)
        except urllib.error.URLError as error:
            self.fail('UPSTREAM_UNAVAILABLE', error)
        except (ValueError, wave.Error) as error:
            self.fail('INVALID_AUDIO', error)
        except OSError as error:
            self.fail('CACHE_UNAVAILABLE', error)
        except RuntimeError as error:
            self.fail('QUEUE_FULL' if str(error) == 'queue-full' else 'INTERNAL_ERROR', error)
        except Exception as error:
            self.fail('INTERNAL_ERROR', error)

    def generate_cached_audio(self, payload, fingerprint):
        """Return validated bytes and cache metadata for speech and warm alike."""
        if not self.server.slots.acquire(blocking=False):
            raise RuntimeError('queue-full')
        try:
            key = cache_key(payload, fingerprint)
            with self.server.disk_lock:
                target = self.server.directory() / (key + '.wav')
                epoch = self.server.epoch
                data = target.read_bytes() if target.is_file() else None
                if data: os.utime(target, None)
            data = self.server.verified(target, data)
            cached = data is not None
            started = time.monotonic()
            if data is None:
                if not self.server.generation_lock.acquire(timeout=300):
                    raise RuntimeError('queue-full')
                try:
                    with self.server.disk_lock:
                        data = target.read_bytes() if target.is_file() else None
                    data = self.server.verified(target, data)
                    cached = data is not None
                    if data is None:
                        request = urllib.request.Request(self.server.upstream + '/v1/audio/speech',
                            data=json.dumps(upstream_payload(self.server.config, payload)).encode(),
                            headers={'Content-Type': 'application/json'})
                        try:
                            with urllib.request.urlopen(request, timeout=300) as response:
                                data = response.read(MAX_AUDIO + 1)
                                declared = response.headers.get('Content-Length', '')
                                if declared.isdigit() and len(data) < int(declared) <= MAX_AUDIO:
                                    # read(amt) returns a short body silently when the engine hangs up.
                                    raise http.client.IncompleteRead(data, int(declared) - len(data))
                        except (http.client.HTTPException, ConnectionError) as error:
                            # urllib wraps only errors raised while sending. An engine that
                            # dies while answering (RemoteDisconnected, IncompleteRead,
                            # ConnectionResetError) is still an unavailable upstream.
                            raise urllib.error.URLError(error) from error
                        validate_wav(data)
                        with self.server.disk_lock:
                            self.server.directory()
                            if epoch == self.server.epoch:
                                descriptor, temporary_name = tempfile.mkstemp(
                                    prefix=target.name + '.', suffix='.tmp', dir=target.parent)
                                temporary = Path(temporary_name)
                                try:
                                    with os.fdopen(descriptor, 'wb') as stream: stream.write(data)
                                    os.replace(temporary, target)
                                finally: temporary.unlink(missing_ok=True)
                                self.server.prune(target)
                finally: self.server.generation_lock.release()
            return dict(data=data, cached=cached, duration=validate_wav(data),
                        elapsed=time.monotonic() - started)
        finally:
            self.server.slots.release()

    def reply(self, code, payload):
        # Once the audio headers are out, a later failure must not inject a
        # second status line into the same stream. Drop the connection instead.
        if getattr(self, 'responded', False):
            self.close_connection = True
            return
        self.responded = True
        # Error paths may not have consumed the request body. Only the audio
        # response, written directly below in do_POST, reuses the connection.
        self.close_connection = True
        data = json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def reply_error(self, code, message=None):
        status, payload = error_payload(code, message)
        self.reply(status, payload)

    def fail(self, code, error):
        # The code and the exception class only: its message may echo request details.
        where = ''
        if code == 'INTERNAL_ERROR':
            frames = traceback.extract_tb(error.__traceback__)
            if frames:
                where = f' em {Path(frames[-1].filename).name}:{frames[-1].lineno}'
        print(f'[nlr] {code}: {type(error).__name__}{where}', flush=True)
        self.reply_error(code)

def main():
    config = validate(read_config())
    identity(config)  # Compute hashes before declaring readiness; reused thereafter.
    server = Server(('127.0.0.1', 8081), config)
    print(f'Novel TTS {APP_VERSION} · Qwen3-TTS · cache autenticado em 127.0.0.1:8081', flush=True)
    server.serve_forever()

if __name__ == '__main__': main()
