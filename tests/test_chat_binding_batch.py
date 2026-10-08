import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("binding_plan", ROOT / "runtime/scripts/chat-binding-plan.py")
PLAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN)

MOCK = """#!/usr/bin/env python3
import os, pathlib, sys
root = pathlib.Path(os.environ['CHAT_TEST_ROOT'])
args = sys.argv[1:]
with (root / 'calls').open('a') as log:
    log.write(repr(args) + '\\n')
if args[0] == 'ps':
    print('dune-postgres\\ndune-rmq-game')
elif 'psql' in args:
    sql = args[-1]
    if 'from dune.guilds' in sql: print('7')
    elif 'from dune.factions' in sql: print('1')
    elif 'from dune.guild_members' in sql:
        for i in range(11): print(f'7\\tuser{i}_queue')
    elif 'from dune.player_faction pf' in sql:
        for i in range(11): print(f'1\\tuser{i}_queue')
    elif 'keys' in sql:
        for i in range(11):
            print(f'user{i}\\tuser{i}_queue')
            print(f'funcom{i}\\tuser{i}_queue')
    elif 'player.#.' in sql:
        for i in range(11): print(f'player.#.funcom{i}\\tuser{i}_queue')
    elif 'dune.world_partition' in sql:
        for i in range(11): print(f'HaggaBasin.0\\tuser{i}_queue')
elif 'list_exchanges' in args:
    print('chat.guild.7\\tfanout\\ttrue\\nchat.faction.1\\tfanout\\tfalse\\nchat.map\\tdirect\\ttrue\\nchat.whispers\\tdirect\\ttrue\\nchat.proximity\\tdirect\\ttrue\\nnotifications\\ttopic\\ttrue')
elif 'list_queues' in args:
    for i in range(11): print(f'user{i}_queue')
elif 'list_bindings' in args:
    if os.environ.get('CHAT_ALL_EXIST'):
        for i in range(11):
            for exchange in ('chat.guild.7', 'chat.faction.1'):
                print(f'{exchange}\\tuser{i}_queue\\tqueue\\t')
            print(f'chat.map\\tuser{i}_queue\\tqueue\\tHaggaBasin.0')
            print(f'notifications\\tuser{i}_queue\\tqueue\\tplayer.#.funcom{i}')
            for exchange in ('chat.whispers', 'chat.proximity'):
                for key in (f'user{i}', f'funcom{i}'):
                    print(f'{exchange}\\tuser{i}_queue\\tqueue\\t{key}')
elif 'eval' in args:
    (root / 'batch').write_text(args[-1])
    print('chat-bindings-failed' if os.environ.get('CHAT_FAIL') else 'chat-bindings-ok')
else: sys.exit(1)
"""


class BindingTests(unittest.TestCase):
    def test_rejects_erlang_injection(self):
        for plan in ('bad"exchange\\tkey\\tplayer_queue', 'exchange\tkey\twrong', 'exchange\tkey\tplayer_queue\textra'):
            with self.assertRaises(ValueError):
                PLAN.expression(plan)
        expression = PLAN.expression('chat.guild.7\t\tplayer_queue\nnotifications\tplayer.#.abc\tplayer_queue')
        self.assertEqual(expression.count('{binding,'), 2)
        self.assertIn('catch rabbit_binding:add', expression)
        self.assertNotIn('delete', expression)

    def run_repair(self, **options):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            repo = folder / 'repo'
            (repo / 'runtime/scripts/lib').mkdir(parents=True)
            for name in ('repair-chat-exchanges.sh', 'chat-binding-plan.py'):
                shutil.copy(ROOT / 'runtime/scripts' / name, repo / 'runtime/scripts' / name)
            for name in ('postgres.sh', 'ports.sh'):
                shutil.copy(ROOT / 'runtime/scripts/lib' / name, repo / 'runtime/scripts/lib' / name)
            mock = folder / 'docker'
            mock.write_text(MOCK)
            mock.chmod(0o755)
            env = {**os.environ, 'PATH': str(folder) + os.pathsep + os.environ['PATH'], 'CHAT_TEST_ROOT': temp, 'DUNE_PSQL_TRANSPORT': 'exec', **options}
            result = subprocess.run(['bash', str(repo / 'runtime/scripts/repair-chat-exchanges.sh')], env=env, capture_output=True, text=True, timeout=15)
            calls = (folder / 'calls').read_text().splitlines()
            batch = (folder / 'batch').read_text() if (folder / 'batch').exists() else ''
            return result, calls, batch

    def test_88_missing_bindings_use_one_eval(self):
        result, calls, batch = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum("'eval'" in call for call in calls), 1)
        self.assertEqual(sum("'list_bindings'" in call for call in calls), 1)
        self.assertEqual(batch.count('{binding,'), 88)
        self.assertIn('Ensured notification queue bindings: 11', result.stdout)

    def test_existing_bindings_do_not_invoke_eval(self):
        result, calls, batch = self.run_repair(CHAT_ALL_EXIST='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum("'eval'" in call for call in calls), 0)
        self.assertEqual(batch, '')

    def test_failure_is_not_reported_as_success(self):
        result, _, _ = self.run_repair(CHAT_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('retried', result.stderr)
        self.assertNotIn('Ensured', result.stdout)


if __name__ == '__main__':
    unittest.main()
