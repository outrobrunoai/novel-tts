import collections
import contextlib
import io
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from io import StringIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import novel_tts as host


VOICE_NAME = 'fixture-voice'
PRIVATE_MARKERS = ('fixture-token', '/private/fixture', 'private transcript marker')


class FakeQwenHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.events.append(('GET', self.path))
        sequence = self.server.get_responses[self.path]
        status, body = sequence.popleft() if sequence else self.server.default_response(self.path)
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_POST(self):
        self.server.events.append(('POST', self.path))
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.post_payloads.append(body)
        status = self.server.post_statuses.popleft() if self.server.post_statuses else 201
        response_body = self.server.post_body
        self.send_response(status)
        self.send_header('Content-Length', str(len(response_body)))
        self.end_headers()
        try:
            self.wfile.write(response_body)
        except BrokenPipeError:
            pass
        if status in (200, 201, 409) and self.server.confirm_voice_after_post:
            self.server.voice_payloads.append(self.server.confirm_voice_after_post)

    def log_message(self, *_args):
        pass


class FakeQwenServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), FakeQwenHandler)
        self.events = []
        self.get_responses = collections.defaultdict(collections.deque)
        self.voice_payloads = []
        self.post_payloads = []
        self.post_statuses = collections.deque()
        self.post_body = b'{"detail":"private transcript marker /private/fixture fixture-token"}'
        self.confirm_voice_after_post = None
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def default_response(self, path):
        if path == '/v1/audio/voices':
            body = json.dumps({'voices': self.voice_payloads}).encode()
        else:
            body = b'{"ok":true}'
        return 200, body

    @property
    def posts(self):
        return [path for method, path in self.events if method == 'POST']

    @property
    def gets(self):
        return [path for method, path in self.events if method == 'GET']

    def respond(self, path, *responses):
        self.get_responses[path].extend(responses)

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class FakeChild:
    pid = 424242

    def __init__(self, code=None):
        self.code = code

    def poll(self):
        return self.code


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration


def profile_for(port):
    return {
        'argv': ['/fixture/tts-server', '--host', '127.0.0.1', '--port', str(port)],
        'cwd': '/fixture',
        'voices': {VOICE_NAME: {'spk': '/private/fixture', 'rvq': '/private/fixture',
                                'text': '/private/fixture'}},
    }


def successful_payload(_name, _voice):
    return {'name': VOICE_NAME, 'ref_text': 'private transcript marker',
            'spk_b64': 'c3Br', 'rvq_b64': 'cnZx'}


class QwenPortFlowTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeQwenServer()
        self.addCleanup(self.fake.close)
        self.profile = profile_for(self.fake.server_port)
        self.clock = FakeClock()
        self.probe = lambda *_args: 'owned'

    def register(self, *, timeout=5, process=None, probe=None, opener=None):
        with patch.object(host, 'voice_payload', side_effect=successful_payload):
            return host.register_when_ready(
                process or FakeChild(), self.profile, timeout=timeout,
                listener_probe=probe or self.probe,
                opener=opener,
                clock=self.clock,
                sleeper=self.clock.sleep,
            )

    def test_default_and_alternative_profiles_resolve_their_own_endpoints(self):
        self.assertEqual(host.qwen_endpoint(profile_for(8080)), 'http://127.0.0.1:8080')
        self.assertEqual(host.qwen_endpoint(profile_for(18080)), 'http://127.0.0.1:18080')

    def test_voice_already_present_skips_post_and_waits_for_health_and_list(self):
        self.fake.voice_payloads.append({'name': VOICE_NAME})
        self.register()
        self.assertEqual(self.fake.posts, [])
        self.assertEqual(self.fake.gets[:2], ['/health', '/v1/audio/voices'])

    def test_voice_endpoint_404_is_retried_until_available(self):
        self.fake.respond('/v1/audio/voices', (404, b'private fixture response'),
                          (404, b'private fixture response'),
                          (200, json.dumps({'voices': [VOICE_NAME]}).encode()))
        self.register()
        self.assertEqual(self.fake.posts, [])
        self.assertEqual(self.fake.gets.count('/v1/audio/voices'), 3)

    def test_transient_connection_refusal_is_retried(self):
        original = host.urllib.request.urlopen
        failures = {'count': 0}

        def refusing_first_voice_get(request, **kwargs):
            url = request.full_url if hasattr(request, 'full_url') else str(request)
            if url.endswith('/v1/audio/voices') and failures['count'] < 2:
                failures['count'] += 1
                raise urllib.error.URLError(ConnectionRefusedError('private endpoint marker'))
            return original(request, **kwargs)

        self.fake.voice_payloads.append(VOICE_NAME)
        self.register(opener=refusing_first_voice_get)
        self.assertEqual(failures['count'], 2)
        self.assertEqual(self.fake.posts, [])

    def test_registration_503_then_200_is_retried_and_confirmed(self):
        self.fake.post_statuses.extend([503, 200])
        self.fake.confirm_voice_after_post = {'name': VOICE_NAME}
        self.register()
        self.assertEqual(len(self.fake.posts), 2)
        self.assertEqual(self.fake.posts, ['/v1/audio/voices'] * 2)

    def test_successful_registration_is_followed_by_confirming_list_query(self):
        self.fake.post_statuses.append(200)
        self.fake.confirm_voice_after_post = {'name': VOICE_NAME}
        self.register()
        methods = [method for method, _path in self.fake.events]
        post_index = methods.index('POST')
        self.assertIn(('GET', '/v1/audio/voices'), self.fake.events[post_index + 1:])

    def test_conflict_is_followed_by_query_without_duplicate_post(self):
        self.fake.post_statuses.append(409)
        self.fake.confirm_voice_after_post = {'name': VOICE_NAME}
        self.register()
        self.assertEqual(len(self.fake.posts), 1)
        self.assertGreaterEqual(self.fake.gets.count('/v1/audio/voices'), 2)

    def test_object_name_is_accepted_and_malformed_items_do_not_confirm(self):
        self.fake.respond('/v1/audio/voices', (200, b'{"voices":[{"id":"fixture-voice"}, null]}'),
                          (200, b'{"voices":[{"name":"fixture-voice"}]}'))
        self.register()
        self.assertEqual(len(self.fake.posts), 1)

    def test_legacy_string_list_is_accepted(self):
        self.fake.voice_payloads.append(VOICE_NAME)
        self.register()
        self.assertEqual(self.fake.posts, [])

    def test_permanent_registration_statuses_fail_without_retry(self):
        for status in (400, 401, 403, 422):
            with self.subTest(status=status):
                self.fake.events.clear()
                self.fake.post_statuses.clear()
                self.fake.post_statuses.append(status)
                with self.assertRaises(host.ReadinessFailure) as raised:
                    self.register(timeout=4)
                self.assertEqual(raised.exception.diagnostic_code,
                                 'NLR_VOICE_REGISTRATION_REJECTED')
                self.assertEqual(len(self.fake.posts), 1)
                self.assertEqual(self.clock.now, 0)

    def test_permanent_voice_endpoint_statuses_fail_without_retry_or_post(self):
        for status in (400, 401, 403, 422):
            with self.subTest(status=status):
                self.fake.events.clear()
                self.fake.respond('/v1/audio/voices', (status, b'private response marker'))
                with self.assertRaises(host.ReadinessFailure) as raised:
                    self.register(timeout=4)
                self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_API_REJECTED')
                self.assertEqual(self.fake.posts, [])
                self.assertEqual(self.clock.now, 0)
                for marker in PRIVATE_MARKERS:
                    self.assertNotIn(marker, str(raised.exception))

    def test_permanent_health_status_fails_before_voice_query(self):
        self.fake.respond('/health', (401, b'private response marker'))
        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(timeout=4)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_API_REJECTED')
        self.assertEqual(self.fake.gets, ['/health'])
        self.assertEqual(self.fake.posts, [])

    def test_process_exit_during_poll_fails_immediately(self):
        child = FakeChild()
        original = host.urllib.request.urlopen

        def exit_during_voice_list(request, **kwargs):
            url = request.full_url if hasattr(request, 'full_url') else str(request)
            response = original(request, **kwargs)
            if url.endswith('/v1/audio/voices'):
                child.code = 9
            return response

        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(process=child, opener=exit_during_voice_list)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_PROCESS_EXITED')
        self.assertEqual(self.fake.posts, [])

    def test_listener_owner_change_during_poll_prevents_registration(self):
        states = collections.deque(['owned', 'owned', 'owned', 'foreign'])

        def changing_probe(*_args):
            return states.popleft() if states else 'foreign'

        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(probe=changing_probe)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_PORT_CONFLICT')
        self.assertEqual(self.fake.posts, [])

    def test_total_deadline_is_bounded_and_returns_voice_api_code(self):
        def unavailable(_request, **_kwargs):
            raise urllib.error.URLError(ConnectionRefusedError('private endpoint'))

        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(timeout=0.35, opener=unavailable)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_VOICE_API_UNAVAILABLE')
        self.assertLessEqual(self.clock.now, 0.35)
        self.assertLessEqual(len(self.clock.sleeps), 3)
        self.assertEqual(self.fake.posts, [])

    def test_accepted_registration_without_confirmation_has_specific_timeout(self):
        self.fake.post_statuses.append(201)
        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(timeout=0.35)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_VOICE_NOT_CONFIRMED')
        self.assertEqual(len(self.fake.posts), 1)

    def test_errors_do_not_expose_payload_text_voice_or_paths(self):
        self.fake.post_statuses.append(400)
        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register()
        diagnostic = str(raised.exception)
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_VOICE_REGISTRATION_REJECTED')
        for marker in PRIVATE_MARKERS + (VOICE_NAME,):
            self.assertNotIn(marker, diagnostic)

    def test_missing_or_malformed_local_voice_payload_fails_before_network(self):
        malformed = [
            {'name': VOICE_NAME, 'ref_text': 'fixture', 'spk_b64': '', 'rvq_b64': 'cnZx'},
            {'name': VOICE_NAME, 'ref_text': 'fixture', 'spk_b64': '!!!', 'rvq_b64': 'cnZx'},
            {'name': VOICE_NAME, 'ref_text': 'fixture', 'spk_b64': 'c3Br',
             'rvq_b64': 'cnZx', 'unexpected': 'private marker'},
        ]
        for value in malformed:
            with self.subTest(payload_fields=tuple(value)):
                with patch.object(host, 'voice_payload', return_value=value), \
                        patch.object(host.urllib.request, 'urlopen') as opener:
                    with self.assertRaises(host.ReadinessFailure) as raised:
                        host.register_voice(VOICE_NAME, self.profile['voices'][VOICE_NAME],
                                            host.qwen_endpoint(self.profile))
                self.assertEqual(raised.exception.diagnostic_code, 'NLR_VOICE_PAYLOAD_INVALID')
                opener.assert_not_called()
                for marker in PRIVATE_MARKERS + (VOICE_NAME,):
                    self.assertNotIn(marker, str(raised.exception))
        with tempfile.TemporaryDirectory() as directory:
            missing_assets = {key: str(Path(directory) / key) for key in ('spk', 'rvq', 'text')}
            with patch.object(host.urllib.request, 'urlopen') as opener:
                with self.assertRaises(host.ReadinessFailure) as raised:
                    host.register_voice(VOICE_NAME, missing_assets,
                                        host.qwen_endpoint(self.profile))
            self.assertEqual(raised.exception.diagnostic_code, 'NLR_VOICE_PAYLOAD_INVALID')
            opener.assert_not_called()
            for marker in PRIVATE_MARKERS + (VOICE_NAME,):
                self.assertNotIn(marker, str(raised.exception))

    def test_alternative_port_receives_voice_registration_at_profile_endpoint(self):
        self.fake.post_statuses.append(201)
        self.fake.confirm_voice_after_post = VOICE_NAME
        self.register()
        self.assertTrue(all(path == '/v1/audio/voices' for path in self.fake.posts))

    def test_foreign_listener_is_rejected_before_any_voice_post(self):
        with self.assertRaises(host.ReadinessFailure) as raised:
            self.register(probe=lambda *_args: 'foreign')
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_PORT_CONFLICT')
        self.assertEqual(self.fake.posts, [])

    def test_preexisting_unrelated_listener_is_a_startup_port_conflict(self):
        with self.assertRaises(host.ReadinessFailure):
            host.ensure_qwen_port_available(profile_for(self.fake.server_port))
        self.assertEqual(self.fake.posts, [])

    def test_time_wait_left_by_previous_qwen_is_not_a_port_conflict(self):
        # A restarted Qwen leaves TIME_WAIT entries on its port for about a
        # minute; only a live listener is a conflict.
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('127.0.0.1', 0))
        port = server.getsockname()[1]
        server.listen()
        client = socket.create_connection(('127.0.0.1', port))
        accepted, _ = server.accept()
        accepted.close()  # the server closes first, as tts-server does
        time.sleep(0.05)
        client.close()
        server.close()
        host.ensure_qwen_port_available(profile_for(port))

    def test_child_pids_fall_back_to_stat_scan_without_children_file(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for pid, ppid, command in ((100, 1, 'python3'), (200, 100, 'tts server)'), (300, 7, 'other')):
                (proc / str(pid)).mkdir()
                (proc / str(pid) / 'stat').write_text(f'{pid} ({command}) S {ppid} 0 0 0\n')
            ctl = Mock(return_value=Mock(stdout='100\n'))
            self.assertEqual(host.qwen_service_child_pids(ctl, proc_root=proc), [200])

    def test_child_pids_prefer_the_children_file_when_present(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            task = proc / '100' / 'task' / '100'
            task.mkdir(parents=True)
            (task / 'children').write_text('201 202 \n')
            ctl = Mock(return_value=Mock(stdout='100\n'))
            self.assertEqual(host.qwen_service_child_pids(ctl, proc_root=proc), [201, 202])

    def test_stat_scan_survives_an_unrelated_process_with_a_non_utf8_name(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for pid in (100, 200, 300):
                (proc / str(pid)).mkdir()
            (proc / '100' / 'stat').write_bytes(b'100 (python3) S 1 0\n')
            (proc / '200' / 'stat').write_bytes(b'200 (tts-server) S 100 0\n')
            (proc / '300' / 'stat').write_bytes(b'300 (caf\xc3) S 7 0\n')  # comm cut inside a UTF-8 sequence
            (proc / 'self').mkdir()
            (proc / '400').mkdir()  # exited between listing and reading: no stat file
            ctl = Mock(return_value=Mock(stdout='100\n'))
            self.assertEqual(host.qwen_service_child_pids(ctl, proc_root=proc), [200])

    def test_unreadable_service_state_is_unknown_not_an_empty_child_list(self):
        for output in ('not-a-pid\n', ''):
            ctl = Mock(return_value=Mock(stdout=output))
            self.assertIsNone(host.qwen_service_child_pids(ctl, proc_root=Path('/nonexistent-proc')))
        ctl = Mock(side_effect=OSError('systemctl missing'))
        self.assertIsNone(host.qwen_service_child_pids(ctl, proc_root=Path('/nonexistent-proc')))

    def test_stopped_service_has_no_children(self):
        ctl = Mock(return_value=Mock(stdout='0\n'))
        self.assertEqual(host.qwen_service_child_pids(ctl, proc_root=Path('/nonexistent-proc')), [])

    def test_listener_with_undetermined_owner_is_unknown_not_foreign(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc / 'net').mkdir()
            (proc / 'net' / 'tcp').write_text(
                '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
                '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0\n')
            self.assertEqual(host.qwen_listener_status('127.0.0.1', 8080, None, proc_root=proc), 'unknown')
            self.assertEqual(host.qwen_listener_status('127.0.0.1', 8080, [], proc_root=proc), 'foreign')
            self.assertEqual(host.qwen_listener_status('127.0.0.1', 8081, None, proc_root=proc), 'waiting')

    def test_launch_refuses_occupied_port_before_starting_qwen(self):
        profile = profile_for(18080)
        config = {'profiles': {'qwen': profile}, 'mode': 'qwen'}
        with patch.object(host, 'validate'), patch.object(host, 'active_profile', return_value=profile), \
                patch.object(host, 'ensure_qwen_port_available', side_effect=ValueError('port occupied')), \
                patch.object(host.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(ValueError, 'port occupied'):
                host.launch(config)
        popen.assert_not_called()

    def test_child_initialization_failure_never_probes_or_registers(self):
        probe = Mock()
        registrar = Mock()
        with self.assertRaises(host.ReadinessFailure) as raised:
            host.register_when_ready(
                FakeChild(code=1), profile_for(18080), timeout=0.2,
                listener_probe=probe, voice_registrar=registrar,
            )
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_PROCESS_EXITED')
        probe.assert_not_called()
        registrar.assert_not_called()

    def test_wait_ready_and_doctor_share_voice_object_interpretation(self):
        class Response(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_args): return False

        config = {'mode': 'qwen', 'voice': VOICE_NAME, 'token': 'fixture-token',
                  'profiles': {'qwen': profile_for(18080)}}
        replies = [Response(b'{"ok":true}'), Response(b'{"voices":[{"name":"fixture-voice"}]}'),
                   Response(json.dumps({'version': host.VERSION, 'mode': 'qwen'}).encode()), Response(b'{"mode":"qwen"}')]
        urls = []

        def opener(request, **_kwargs):
            url = request.full_url if hasattr(request, 'full_url') else str(request)
            urls.append(url)
            return replies.pop(0)

        owner = lambda _host, port, _pids: 'owned' if port == 18080 else 'foreign'
        host.wait_ready(config, timeout=2, qwen_pids=[424242], listener_probe=owner, opener=opener)
        self.assertTrue(urls[0].endswith('/health'))
        self.assertTrue(urls[1].endswith('/v1/audio/voices'))
        replies = iter([Response(b'{"voices":[{"name":"fixture-voice"}]}'),
                        Response(json.dumps({'version': host.VERSION, 'mode': 'qwen'}).encode()),
                        Response(b'{"mode":"qwen"}')])

        def ctl(action, *_args, **_kwargs):
            state = 'active' if action == 'is-active' else 'enabled'
            return type('Result', (), {'stdout': state + '\n'})()

        with patch.object(host, 'validate'):
            report = host.doctor_report(config, ctl=ctl,
                opener=lambda *_args, **_kwargs: next(replies), qwen_pids=[424242], listener_probe=owner)
        self.assertEqual(report['code'], 0)
        self.assertNotIn(VOICE_NAME, json.dumps(report))

    def test_launch_success_message_does_not_echo_voice_identifiers(self):
        profile = self.profile
        child = Mock()
        child.poll.return_value = 0
        child.wait.return_value = 0
        output = StringIO()
        with patch.object(host, 'validate'), patch.object(host, 'active_profile', return_value=profile), \
                patch.object(host, 'ensure_qwen_port_available'), patch.object(host.subprocess, 'Popen', return_value=child), \
                patch.object(host, 'register_when_ready'):
            with contextlib.redirect_stdout(output):
                host.launch({'mode': 'qwen'})
        self.assertNotIn(VOICE_NAME, output.getvalue())
        self.assertIn('vozes configuradas verificadas', output.getvalue())


if __name__ == '__main__':
    unittest.main()
