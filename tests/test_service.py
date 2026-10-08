import concurrent.futures
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from companion_server import (ERRORS, MAX_BODY, PROTOCOL_CURRENT, PROTOCOL_MAXIMUM,
                              PROTOCOL_MINIMUM, SERVICE_VERSION, Server,
                              cache_key, canonical_request, error_payload,
                              validate_wav)
from nlr_config import (atomic_json, identity, migrate_schema_2_to_3, option,
                        persist_migrated_config, read_config, requires_mount,
                        resolve_voice, set_option, validate)
from novel_tts import parse_unit, unit_text


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, 'wb') as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(b'\0\0' * 2400)
    return output.getvalue()


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.server.calls += 1
        self.server.payloads.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        if self.server.delay:
            time.sleep(self.server.delay)
        mode = getattr(self.server, 'mode', None)
        if mode == 'drop':  # the engine dies before it answers
            self.close_connection = True
            return
        if mode == 'truncate':  # the engine dies in the middle of the body
            self.send_response(200)
            self.send_header('Content-Length', '100000')
            self.end_headers()
            self.wfile.write(b'RIFF')
            self.close_connection = True
            return
        if mode == 'garbage':  # a complete answer that is not audio at all
            self.send_response(200)
            self.send_header('Content-Length', '4')
            self.end_headers()
            self.wfile.write(b'RIFF')
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(self.server.audio)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"voices":["sample_voice"]}')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        for name, data in (
            ('model.gguf', b'model-A'), ('codec.gguf', b'codec-A'),
            ('voice.spk', b'speaker-A'), ('voice.rvq', b'codes-A'),
            ('voice.txt', b'exact transcript'), ('other.spk', b'speaker-B'),
            ('other.rvq', b'codes-B'), ('other.txt', b'other transcript'),
        ):
            (root / name).write_bytes(data)
        (root / 'tts-server').write_bytes(b'fake-binary')
        (root / 'tts-server').chmod(0o755)
        voices = {
            'sample_voice': {'spk': str(root / 'voice.spk'), 'rvq': str(root / 'voice.rvq'),
                        'text': str(root / 'voice.txt')},
            'other': {'spk': str(root / 'other.spk'), 'rvq': str(root / 'other.rvq'),
                      'text': str(root / 'other.txt')},
        }
        self.config = {
            'schema': 2, 'backend': 'qwen3', 'mode': 'qwen', 'data_root': str(root),
            'voice': 'sample_voice', 'cache_dir': str(root / 'cache'), 'cache_limit_mb': 100,
            'token': 'test-' + 'x' * 40,
            'profiles': {'qwen': {'cwd': str(root), 'backend': 'qwen3',
                'argv': [str(root / 'tts-server'), '--model', str(root / 'model.gguf'),
                         '--codec', str(root / 'codec.gguf'), '--host', '127.0.0.1',
                         '--port', '8080', '--lang', 'English', '--max-batch', '1'], 'voices': voices}},
        }
        self.up = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.up.calls = 0
        self.up.payloads = []
        self.up.delay = 0
        self.up.audio = wav_bytes()
        self.server = Server(('127.0.0.1', 0), self.config,
                             f'http://127.0.0.1:{self.up.server_port}', check_mount=False)
        for server in (self.up, self.server):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.up.shutdown()
        self.server.server_close()
        self.up.server_close()
        self.tmp.cleanup()

    def request(self, path, data=None, method=None, token=True, headers=None):
        request_headers = {'Content-Type': 'application/json'}
        if token:
            request_headers['Authorization'] = 'Bearer ' + self.config['token']
        request_headers.update(headers or {})
        request = urllib.request.Request(
            f'http://127.0.0.1:{self.server.server_port}' + path,
            data=None if data is None else json.dumps(data).encode(), method=method,
            headers=request_headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read(), error.headers
            finally:
                error.close()

    def test_token_required_for_every_endpoint(self):
        for path, method in [('/health', 'GET'), ('/voices', 'GET'), ('/cache', 'DELETE'),
                             ('/v1/audio/speech', 'POST')]:
            self.assertEqual(self.request(path, method=method, token=False)[0], 401)

    def test_capabilities_are_authenticated_complete_and_private(self):
        self.assertEqual(self.request('/v1/nlr/capabilities', token=False)[0], 401)
        self.assertEqual(self.request('/v1/nlr/capabilities', headers={'Host': 'attacker.example'})[0], 403)
        self.assertEqual(self.request('/v1/nlr/capabilities', headers={'Origin': 'https://example.org'})[0], 403)
        code, body, _ = self.request('/v1/nlr/capabilities')
        self.assertEqual(code, 200)
        data = json.loads(body)
        self.assertEqual(data['service_version'], SERVICE_VERSION)
        self.assertEqual(data['protocol'], {'current': PROTOCOL_CURRENT, 'minimum': PROTOCOL_MINIMUM, 'maximum': PROTOCOL_MAXIMUM})
        self.assertEqual(data['backend'], {'name': 'qwen3', 'variant': 'base'})
        self.assertEqual(data['capabilities']['style_instructions'], False)
        self.assertEqual(data['capabilities']['cache_warming'], True)
        serialized = json.dumps(data)
        for private in (self.config['token'], self.config['cache_dir'], 'model.gguf', 'voice.spk', 'exact transcript'):
            self.assertNotIn(private, serialized)

    def test_structured_error_codes_have_stable_status_and_no_private_data(self):
        for name, (status, retryable, _) in ERRORS.items():
            actual_status, payload = error_payload(name)
            self.assertEqual(actual_status, status)
            self.assertEqual(payload['error']['code'], name)
            self.assertEqual(payload['error']['retryable'], retryable)
            self.assertIsInstance(payload['error']['message'], str)
            serialized = json.dumps(payload)
            for private in (self.config['token'], self.config['cache_dir'], 'exact transcript', 'Authorization'):
                self.assertNotIn(private, serialized)
        cases = [
            ('/missing', None, 'GET', {}, 'ENDPOINT_NOT_FOUND'),
            ('/v1/audio/speech', {'input': 'x'}, 'POST', {'Content-Type': 'text/plain'}, 'UNSUPPORTED_MEDIA_TYPE'),
            ('/v1/audio/speech', {'input': ''}, 'POST', {}, 'INVALID_REQUEST'),
            ('/v1/audio/speech', {'input': 'x', 'voice': 'missing'}, 'POST', {}, 'VOICE_NOT_FOUND'),
        ]
        for path, data, method, headers, expected in cases:
            _, body, _ = self.request(path, data=data, method=method, headers=headers)
            self.assertEqual(json.loads(body)['error']['code'], expected)

    def test_host_and_web_origin_rejected(self):
        self.assertEqual(self.request('/health', headers={'Origin': 'https://example.org'})[0], 403)
        self.assertEqual(self.request('/health', headers={'Host': 'attacker.example'})[0], 403)

    def test_extension_origin_allowed_without_wildcard(self):
        code, _, headers = self.request('/health', headers={'Origin': 'moz-extension://testing'})
        self.assertEqual(code, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'moz-extension://testing')

    def test_health_reports_qwen_and_registered_voices(self):
        code, body, headers = self.request('/health')
        self.assertEqual(code, 200)
        self.assertTrue(headers['Server'].startswith('NovelTTS/1.0'))
        health = json.loads(body)
        self.assertTrue(health['upstream'])
        self.assertEqual(health['backend'], 'qwen3')
        self.assertEqual(health['version'], SERVICE_VERSION)
        self.assertEqual(health['service_version'], SERVICE_VERSION)
        self.assertEqual(health['protocol']['current'], PROTOCOL_CURRENT)
        self.assertEqual(json.loads((ROOT / 'manifest.json').read_text())['version'], SERVICE_VERSION)
        self.assertIn(f'const APP_VERSION = "{SERVICE_VERSION}"', (ROOT / 'protocol.js').read_text())
        self.assertIn(f'protocolo de aplicação {PROTOCOL_CURRENT}', (ROOT / 'docs/GUIDE.md').read_text())
        _, body, _ = self.request('/voices')
        self.assertEqual(json.loads(body), {'voices': ['other', 'sample_voice'], 'default_voice': 'sample_voice'})

    def test_json_schema_validation(self):
        for data in [[], {}, {'input': ''}, {'input': 'x' * 4001},
                     {'input': 'ok', 'temperature': True}, {'input': 'ok', 'seed': 1.1}]:
            self.assertEqual(self.request('/v1/audio/speech', data=data)[0], 400)
        self.assertEqual(self.request('/v1/audio/speech', {'input': 'hi'},
                                      headers={'Content-Type': 'text/plain'})[0], 415)

    def test_cache_hit_avoids_generation(self):
        first = self.request('/v1/audio/speech', {'input': 'Hello'})
        second = self.request('/v1/audio/speech', {'input': 'Hello'})
        self.assertEqual(first[0], 200)
        self.assertEqual(second[2]['X-NLR-Cache'], 'HIT')
        self.assertEqual(self.up.calls, 1)

    def test_warm_cache_returns_only_small_private_metadata_and_shares_speech_key(self):
        request = {'input': 'Warm this paragraph', 'voice': 'other', 'temperature': .7, 'seed': 8}
        code, body, headers = self.request('/v1/nlr/cache/warm', request)
        self.assertEqual(code, 200)
        self.assertEqual(headers['Content-Type'], 'application/json')
        result = json.loads(body)
        self.assertEqual(set(result), {'status', 'cached', 'duration', 'elapsed', 'fingerprint'})
        self.assertEqual(result['status'], 'ready')
        self.assertFalse(result['cached'])
        self.assertGreater(result['duration'], 0)
        self.assertNotIn('Warm this paragraph', body.decode())
        self.assertNotIn(self.config['token'], body.decode())
        code, audio, speech_headers = self.request('/v1/audio/speech', request)
        self.assertEqual(code, 200)
        self.assertEqual(speech_headers['X-NLR-Cache'], 'HIT')
        self.assertEqual(audio, self.up.audio)
        self.assertEqual(self.up.calls, 1)

    def test_warm_cache_rejects_extra_fields_and_obeys_auth_origin_and_body_limits(self):
        self.assertEqual(self.request('/v1/nlr/cache/warm', {'input': 'x'}, token=False)[0], 401)
        self.assertEqual(self.request('/v1/nlr/cache/warm', {'input': 'x'}, headers={'Origin': 'https://bad.test'})[0], 403)
        self.assertEqual(self.request('/v1/nlr/cache/warm', {'input': 'x', 'instructions': 'ignored'})[0], 400)
        self.assertEqual(self.request('/v1/nlr/cache/warm', {'input': 'x'}, headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/v1/nlr/cache/warm', {'input': 'x' * (MAX_BODY + 1)})[0], 413)

    def test_warm_hit_and_corrupt_entry_behave_like_speech_cache(self):
        payload = {'input': 'same warm'}
        self.assertEqual(self.request('/v1/nlr/cache/warm', payload)[0], 200)
        code, body, _ = self.request('/v1/nlr/cache/warm', payload)
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(body)['cached'])
        self.assertEqual(self.up.calls, 1)
        entry = next(Path(self.config['cache_dir']).glob('*.wav'))
        entry.write_bytes(b'broken')
        code, body, _ = self.request('/v1/nlr/cache/warm', payload)
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(body)['cached'])
        self.assertEqual(self.up.calls, 2)

    def test_warm_and_speech_concurrent_requests_share_one_generation(self):
        self.up.delay = .08
        payload = {'input': 'shared request'}
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            warm, speech = list(pool.map(lambda path: self.request(path, payload),
                ('/v1/nlr/cache/warm', '/v1/audio/speech')))
        self.assertEqual(warm[0], 200)
        self.assertEqual(json.loads(warm[1])['status'], 'ready')
        self.assertEqual(speech[0], 200)
        self.assertEqual(speech[1], self.up.audio)
        self.assertEqual(self.up.calls, 1)

    def test_clear_during_warm_generation_does_not_resurrect_a_cache_file(self):
        self.up.delay = .15
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            request = pool.submit(self.request, '/v1/nlr/cache/warm', {'input': 'clear race'})
            time.sleep(.03)
            self.assertEqual(self.request('/cache', method='DELETE')[0], 200)
            self.assertEqual(request.result()[0], 200)
        self.assertFalse(list(Path(self.config['cache_dir']).glob('*.wav')))

    def test_warm_invalid_audio_returns_structured_error_without_temporary_file(self):
        self.up.audio = b'not a wav'
        code, body, _ = self.request('/v1/nlr/cache/warm', {'input': 'invalid upstream'})
        self.assertEqual(code, 502)
        self.assertEqual(json.loads(body)['error']['code'], 'INVALID_AUDIO')
        cache = Path(self.config['cache_dir'])
        self.assertFalse(list(cache.glob('*.tmp')) if cache.exists() else [])

    def test_selected_voice_and_only_qwen_fields_are_forwarded(self):
        code, _, _ = self.request('/v1/audio/speech', {
            'input': 'Other voice', 'voice': 'other', 'instructions': 'sound afraid',
        })
        self.assertEqual(code, 200)
        self.assertEqual(self.up.payloads[-1]['voice'], 'other')
        self.assertNotIn('instructions', self.up.payloads[-1])
        self.assertNotIn('consent_attestation', self.up.payloads[-1])

    def test_legacy_wav_voice_name_maps_to_registered_qwen_voice(self):
        code, _, _ = self.request('/v1/audio/speech', {'input': 'Legacy', 'voice': 'sample_voice.wav'})
        self.assertEqual(code, 200)
        self.assertEqual(self.up.payloads[-1]['voice'], 'sample_voice')
        self.assertEqual(resolve_voice(self.config, 'sample_voice.wav'), 'sample_voice')

    def test_cached_audio_available_while_upstream_is_offline(self):
        self.request('/v1/audio/speech', {'input': 'cached offline'})
        self.server.upstream = 'http://127.0.0.1:1'
        code, _, headers = self.request('/v1/audio/speech', {'input': 'cached offline'})
        self.assertEqual(code, 200)
        self.assertEqual(headers['X-NLR-Cache'], 'HIT')

    def test_parallel_identical_requests_generate_once(self):
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            results = list(pool.map(lambda _: self.request('/v1/audio/speech', {'input': 'Together'}), range(3)))
        self.assertTrue(all(result[0] == 200 for result in results))
        self.assertEqual(self.up.calls, 1)

    def test_corrupt_wav_not_cached(self):
        self.up.audio = b'NOT A WAV'
        code, body, _ = self.request('/v1/audio/speech', {'input': 'bad'})
        self.assertEqual(code, 502)
        self.assertEqual(json.loads(body)['error']['code'], 'INVALID_AUDIO')
        self.assertFalse(list(Path(self.config['cache_dir']).glob('*.wav')))

    def test_wav_truncation_rejected(self):
        with self.assertRaises((ValueError, wave.Error)):
            validate_wav(wav_bytes()[:-10])

    def test_voice_latent_replacement_changes_identity(self):
        first = identity(self.config)
        Path(self.config['profiles']['qwen']['voices']['sample_voice']['rvq']).write_bytes(b'new codes')
        self.assertNotEqual(first, identity(self.config))

    def test_model_and_server_options_change_identity(self):
        first = identity(self.config)
        profile = self.config['profiles']['qwen']
        profile['argv'] = set_option(profile['argv'], '--max-batch', '2')
        self.assertNotEqual(first, identity(self.config))
        first = identity(self.config)
        Path(option(profile['argv'], '--model')).write_bytes(b'model-B')
        self.assertNotEqual(first, identity(self.config))

    def test_path_traversal_and_unknown_voice_rejected(self):
        self.assertEqual(self.request('/v1/audio/speech', {'input': 'Hello', 'voice': '../voice'})[0], 400)
        self.assertEqual(self.request('/v1/audio/speech', {'input': 'Hello', 'voice': 'missing'})[0], 400)

    def test_truncated_cache_entry_is_replaced_instead_of_failing(self):
        self.request('/v1/audio/speech', {'input': 'Hello'})
        entries = list(Path(self.config['cache_dir']).glob('*.wav'))
        entries[0].write_bytes(entries[0].read_bytes()[:40])
        code, _, headers = self.request('/v1/audio/speech', {'input': 'Hello'})
        self.assertEqual(code, 200)
        self.assertEqual(headers['X-NLR-Cache'], 'MISS')
        self.assertEqual(self.up.calls, 2)

    def test_keep_alive_serves_several_requests_on_one_connection(self):
        import http.client
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.config['token']}
        for text in ('one', 'two', 'three'):
            connection.request('POST', '/v1/audio/speech', json.dumps({'input': text}).encode(), headers)
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(len(body), int(response.getheader('Content-Length')))
            self.assertEqual(response.version, 11)
        self.assertFalse(response.will_close)
        connection.close()

    def test_rejected_content_type_closes_instead_of_desyncing(self):
        import http.client
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('POST', '/v1/audio/speech', b'not json', {
            'Content-Type': 'text/plain', 'Authorization': 'Bearer ' + self.config['token'],
        })
        response = connection.getresponse()
        self.assertEqual(response.status, 415)
        response.read()
        self.assertTrue(response.will_close)
        connection.close()

    def test_clear_preserves_qwen_voice_assets(self):
        self.request('/v1/audio/speech', {'input': 'Hello'})
        self.assertEqual(self.request('/cache', method='DELETE')[0], 200)
        voice = self.config['profiles']['qwen']['voices']['sample_voice']
        self.assertTrue(Path(voice['spk']).exists())
        self.assertTrue(Path(voice['rvq']).exists())
        self.assertFalse(list(Path(self.config['cache_dir']).glob('*.wav')))

    def test_config_file_and_mount_guard(self):
        path = Path(self.tmp.name) / 'config.json'
        atomic_json(path, self.config)
        self.assertEqual(read_config(path)['mode'], 'qwen')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with patch('pathlib.Path.is_mount', return_value=False):
            with self.assertRaises(ValueError):
                validate(self.config)

    def test_schema_2_migration_preserves_values_without_writing_source(self):
        path = Path(self.tmp.name) / 'config.json'
        atomic_json(path, self.config)
        original = path.read_bytes()
        migrated = migrate_schema_2_to_3(read_config(path))
        self.assertEqual(migrated['schema'], 3)
        self.assertTrue(migrated['require_mount'])
        for key in ('token', 'cache_dir', 'cache_limit_mb', 'data_root', 'voice', 'profiles'):
            self.assertEqual(migrated[key], self.config[key])
        self.assertTrue(requires_mount(self.config))
        self.assertTrue(requires_mount(migrated))
        self.assertEqual(path.read_bytes(), original)

    def test_persist_migration_backs_up_before_replacing_configuration(self):
        path = Path(self.tmp.name) / 'config.json'
        atomic_json(path, self.config)
        original = path.read_bytes()
        backup = persist_migrated_config(path, migrate_schema_2_to_3(self.config))
        self.assertEqual(backup.read_bytes(), original)
        self.assertEqual(read_config(path)['schema'], 3)
        self.assertTrue(read_config(path)['require_mount'])

    def test_require_mount_false_allows_normal_cache_and_true_rejects_missing_mount(self):
        portable = migrate_schema_2_to_3(self.config)
        portable['require_mount'] = False
        self.assertFalse(Path(portable['cache_dir']).exists())
        self.assertIs(validate(portable), portable)
        self.assertFalse(Path(portable['cache_dir']).exists())
        portable['require_mount'] = True
        with patch('pathlib.Path.is_mount', return_value=False):
            with self.assertRaises(ValueError):
                validate(portable)

    def test_invalid_or_conflicting_qwen_ports_are_rejected(self):
        portable = migrate_schema_2_to_3(self.config)
        portable['require_mount'] = False
        argv = portable['profiles']['qwen']['argv']
        for port in ('1023', '65536', 'not-a-port', '8081'):
            portable['profiles']['qwen']['argv'] = set_option(argv, '--port', port)
            with self.assertRaises(ValueError):
                validate(portable)

    def test_missing_assets_are_rejected_without_creating_the_cache(self):
        portable = migrate_schema_2_to_3(self.config)
        portable['require_mount'] = False
        portable['profiles']['qwen']['argv'] = set_option(
            portable['profiles']['qwen']['argv'], '--model', Path(self.tmp.name) / 'missing.gguf'
        )
        with self.assertRaises(ValueError):
            validate(portable)
        self.assertFalse(Path(portable['cache_dir']).exists())

    def test_migration_write_failure_preserves_original_configuration(self):
        path = Path(self.tmp.name) / 'config.json'
        atomic_json(path, self.config)
        original = path.read_bytes()
        with patch('nlr_config.atomic_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                persist_migrated_config(path, migrate_schema_2_to_3(self.config))
        self.assertEqual(path.read_bytes(), original)

    def test_server_uses_configured_qwen_port_by_default(self):
        portable = migrate_schema_2_to_3(self.config)
        portable['require_mount'] = False
        profile = portable['profiles']['qwen']
        profile['argv'] = set_option(profile['argv'], '--port', '18080')
        server = Server(('127.0.0.1', 0), portable, check_mount=False)
        try:
            self.assertEqual(server.upstream, 'http://127.0.0.1:18080')
        finally:
            server.server_close()

    def test_cache_management_never_touches_unrelated_wav_files(self):
        cache = self.server.directory()
        personal = cache / 'my-recording.wav'
        personal.write_bytes(wav_bytes())
        code, _, _ = self.request('/v1/audio/speech', {'input': 'Owned entry'})
        self.assertEqual(code, 200)
        code, body, _ = self.request('/cache/stats')
        self.assertEqual(json.loads(body)['count'], 1)
        code, _, _ = self.request('/cache', method='DELETE')
        self.assertEqual(code, 200)
        self.assertTrue(personal.is_file())
        self.assertEqual([path for path in cache.glob('*.wav') if path != personal], [])

    def test_prune_ignores_unrelated_wav_even_when_over_limit(self):
        cache = self.server.directory()
        personal = cache / 'my-recording.wav'
        with personal.open('wb') as stream:
            stream.truncate(150 * 1024 * 1024)  # sparse; above the 100 MiB fixture limit
        with self.server.disk_lock:
            self.server.prune(None)
        self.assertTrue(personal.exists())

    def test_prune_removes_the_oldest_owned_entries_first_and_keeps_the_rest(self):
        cache = self.server.directory()
        names = [letter * 64 + '.wav' for letter in 'abc']
        for age, name in enumerate(names):  # a is the oldest
            with (cache / name).open('wb') as stream:
                stream.truncate(40 * 1024 * 1024)  # sparse
            os.utime(cache / name, (1_000_000 + age, 1_000_000 + age))
        personal = cache / 'my-recording.wav'
        personal.write_bytes(wav_bytes())
        with self.server.disk_lock:
            self.server.prune(cache / names[2])  # 120 MiB owned, 100 MiB limit
        self.assertFalse((cache / names[0]).exists())
        self.assertTrue((cache / names[1]).exists() and (cache / names[2]).exists())
        self.assertTrue(personal.exists())

    def test_server_applies_a_finite_idle_timeout_by_default(self):
        server = Server(('127.0.0.1', 0), self.config, 'http://127.0.0.1:1', check_mount=False)
        try:
            self.assertTrue(0 < server.idle_timeout <= 300)
        finally:
            server.server_close()

    def test_a_synthesis_slower_than_the_idle_timeout_still_succeeds(self):
        self.server.idle_timeout = 0.3
        self.up.delay = 0.8
        code, _, headers = self.request('/v1/audio/speech', {'input': 'Slow engine'})
        self.assertEqual(code, 200)
        self.assertEqual(headers['X-NLR-Cache'], 'MISS')

    def test_idle_connection_is_closed_instead_of_pinning_a_thread(self):
        self.server.idle_timeout = 0.3
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=5) as client:
            started = time.monotonic()
            self.assertEqual(client.recv(1), b'')
        self.assertLess(time.monotonic() - started, 3)

    def test_unmounted_data_root_is_reported_as_cache_unavailable(self):
        self.server.check_mount = True  # schema 2 fixture requires a mounted data_root
        code, body, _ = self.request('/v1/audio/speech', {'input': 'Mount check'})
        self.assertEqual(code, 503)
        self.assertEqual(json.loads(body)['error']['code'], 'CACHE_UNAVAILABLE')
        self.assertEqual(self.up.calls, 0)

    def test_deeply_nested_json_is_an_invalid_request(self):
        request = urllib.request.Request(
            f'http://127.0.0.1:{self.server.server_port}/v1/audio/speech', data=b'[' * 60000,
            headers={'Content-Type': 'application/json',
                     'Authorization': 'Bearer ' + self.config['token']})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 400)
        caught.exception.close()

    def test_engine_dying_mid_answer_is_a_retryable_upstream_failure(self):
        for mode in ('drop', 'truncate'):
            with self.subTest(mode=mode):
                self.up.mode = mode
                log = io.StringIO()
                with contextlib.redirect_stdout(log):
                    code, body, _ = self.request('/v1/audio/speech', {'input': f'Private text {mode}'})
                error = json.loads(body)['error']
                self.assertEqual(code, 502)
                self.assertEqual((error['code'], error['retryable']), ('UPSTREAM_UNAVAILABLE', True))
                self.assertIn('UPSTREAM_UNAVAILABLE', log.getvalue())
                self.assertNotIn('Private text', log.getvalue())
        self.up.mode = None
        self.assertEqual(self.server.stats()['count'], 0)  # nothing partial was cached
        self.assertEqual(self.request('/v1/audio/speech', {'input': 'Recovered'})[0], 200)

    def test_a_complete_but_invalid_engine_answer_is_invalid_audio_not_internal_error(self):
        self.up.mode = 'garbage'
        code, body, _ = self.request('/v1/audio/speech', {'input': 'Garbage answer'})
        self.assertEqual((code, json.loads(body)['error']['code']), (502, 'INVALID_AUDIO'))
        self.assertEqual(self.server.stats()['count'], 0)

    def test_unexpected_failures_are_logged_by_type_without_the_message(self):
        log = io.StringIO()
        with patch('companion_server.Handler.generate_cached_audio', side_effect=KeyError('private-marker')):
            with contextlib.redirect_stdout(log):
                code, body, _ = self.request('/v1/audio/speech', {'input': 'Hello'})
        self.assertEqual((code, json.loads(body)['error']['code']), (500, 'INTERNAL_ERROR'))
        self.assertIn('INTERNAL_ERROR: KeyError', log.getvalue())
        self.assertNotIn('private-marker', log.getvalue())

    def test_unit_override_parser(self):
        data = parse_unit('[Service]\nExecStart=old\n# comment\n[Service]\nExecStart=\nExecStart=/bin/new \\\n+ --server\n')
        self.assertEqual(data['ExecStart'], '/bin/new + --server')
        self.assertIn('StartLimitBurst=3', unit_text('run', 'Test'))
        self.assertNotIn('Requires=', unit_text('cache', 'Test'))

    def test_units_are_sandboxed_and_loopback_only(self):
        cache = unit_text('cache', 'Cache', ('/srv/nlr-cache',))
        tts = unit_text('run', 'TTS')
        for text in (cache, tts):
            self.assertIn('IPAddressDeny=any', text)
            self.assertIn('IPAddressAllow=localhost', text)
            self.assertIn('NoNewPrivileges=yes', text)
        self.assertIn('RestrictAddressFamilies=AF_INET AF_UNIX\n', cache)
        self.assertIn('ProtectSystem=strict', cache)
        self.assertIn('ReadWritePaths="-/srv/nlr-cache"\n', cache)
        self.assertNotIn('PrivateDevices=yes', tts)
        self.assertNotIn('ProtectSystem=strict', tts)

    def test_read_write_paths_survive_spaces_and_percent(self):
        cache = unit_text('cache', 'Cache', ('/srv/Novel TTS/100% cache',))
        line = next(item for item in cache.splitlines() if item.startswith('ReadWritePaths='))
        self.assertEqual(line, 'ReadWritePaths="-/srv/Novel TTS/100%% cache"')

    def test_read_write_paths_keep_non_ascii_characters_literal(self):
        # systemd reads UTF-8 inside double quotes as is; \u escapes are avoided.
        cache = unit_text('cache', 'Cache', ('/srv/Música "ao vivo"',))
        line = next(item for item in cache.splitlines() if item.startswith('ReadWritePaths='))
        self.assertEqual(line, 'ReadWritePaths="-/srv/Música \\"ao vivo\\""')

    def test_cache_key_sensitive_to_voice_identity(self):
        body = canonical_request({'input': 'same'})
        self.assertNotEqual(cache_key(body, 'voice-a'), cache_key(body, 'voice-b'))


if __name__ == '__main__':
    unittest.main()
