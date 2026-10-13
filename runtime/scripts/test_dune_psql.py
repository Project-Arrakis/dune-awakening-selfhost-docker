#!/usr/bin/env python3
"""Unit tests for runtime/scripts/dune_psql.py.

tests/psql-transport-test.sh covers the shell half of the same seam, and the
two files deliberately do not overlap: that one exercises
runtime/scripts/lib/postgres.sh, this one the module the embedded Python blocks
import, and the shell test's final section compares the constants both of them
carry so neither can drift.

Everything here runs the real module in a child interpreter against stub `psql`
and `docker` executables, because the two answers the module produces -- the
transport and the port -- are memoized for the life of a process, and that
memoization is itself part of the contract worth testing. Reaching in to reset
the private cache would test something the publishers never do.

Run directly:
    python3 runtime/scripts/test_dune_psql.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

# Records its argv one element per line, so an argument containing a space
# cannot masquerade as two, and reports what it found on stdin. A real psql
# reads stdin when it is given one; that is what makes the DEVNULL case below
# meaningful. Shell builtins only: PATH holds the stubs and nothing else, so
# that the runner's own psql client cannot decide the transport for us, and an
# external basename or cat would simply not be found.
STUB = """#!/usr/bin/env bash
mapfile -t stdin_lines
{
  printf 'argv0=%s\\n' "${0##*/}"
  printf 'argc=%s\\n' "$#"
  printf '%s\\n' "$@"
  printf 'PGPASSWORD=%s\\n' "${PGPASSWORD-<unset>}"
  printf 'stdin=%s\\n' "${stdin_lines[*]}"
} >> "$DUNE_PSQL_TEST_LOG"
printf 'rows\\n'
"""

QUERY = "import dune_psql, sys; sys.stdout.write(dune_psql.query_tsv('select 1;'))"


class SeamTestCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.log = self.root / "calls.log"

        # Two PATHs, because in `auto` the module chooses by whether a psql
        # client exists, and the runner's own postgresql-client (the GitHub
        # images ship one) must not decide the answer for us.
        for name, tools in (("with-psql", ("psql", "docker")), ("without-psql", ("docker",))):
            directory = self.root / name
            directory.mkdir()
            for tool in tools:
                stub = directory / tool
                stub.write_text(STUB)
                stub.chmod(0o755)
            (directory / "bash").symlink_to("/bin/bash")

    def run_seam(self, path_dir, program=QUERY, stdin=b"", **env):
        """Run one snippet against the module in a pristine environment."""
        if self.log.exists():
            self.log.unlink()
        return subprocess.run(
            [sys.executable, "-c", f"import sys; sys.path.insert(0, {str(SCRIPTS)!r}); " + program],
            cwd=self.root,
            env={
                "PATH": str(self.root / path_dir),
                "HOME": str(self.root),
                "DUNE_PSQL_TEST_LOG": str(self.log),
                **env,
            },
            input=stdin,
            capture_output=True,
        )

    def calls(self):
        return self.log.read_text().splitlines()

    def assertQuerySucceeded(self, result):
        self.assertEqual(
            result.returncode, 0, msg=result.stderr.decode(errors="replace")
        )


class TransportSelectionTests(SeamTestCase):
    def test_a_psql_client_on_path_selects_tcp(self):
        self.assertQuerySucceeded(self.run_seam("with-psql"))
        self.assertEqual(self.calls()[0], "argv0=psql")

    def test_no_psql_client_selects_the_exec_path(self):
        self.assertQuerySucceeded(self.run_seam("without-psql"))
        self.assertEqual(self.calls()[0], "argv0=docker")

    def test_an_explicit_exec_setting_overrides_a_client_on_path(self):
        self.assertQuerySucceeded(self.run_seam("with-psql", DUNE_PSQL_TRANSPORT="exec"))
        self.assertEqual(self.calls()[0], "argv0=docker")

    def test_an_explicit_tcp_setting_does_not_fall_back_to_exec(self):
        # Asking for TCP where no client is installed is a broken deployment, and
        # it has to look like one. Quietly answering with a container exec would
        # hide exactly the state this whole change exists to detect: the console
        # image shipped without psql and resolved `exec` for months.
        result = self.run_seam("without-psql", DUNE_PSQL_TRANSPORT="tcp")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"'psql'", result.stderr)
        self.assertFalse(self.log.exists(), "the exec path ran after TCP was demanded")

    def test_an_empty_setting_falls_back_to_detection(self):
        # start-autoscaler.sh forwards the variable whether or not the operator
        # set one, so the module sees "" far more often than it sees nothing.
        self.assertQuerySucceeded(self.run_seam("with-psql", DUNE_PSQL_TRANSPORT=""))
        self.assertEqual(self.calls()[0], "argv0=psql")

    def test_the_reported_transport_is_the_one_that_runs(self):
        # doctor.sh prints this for a running container. A reading that came from
        # anywhere but the seam's own answer would be worse than no reading: the
        # console sat on the exec path while nothing said so.
        for path_dir, expected in (("with-psql", "tcp"), ("without-psql", "exec")):
            with self.subTest(path_dir=path_dir):
                program = (
                    "import dune_psql, sys; "
                    "sys.stdout.write(dune_psql.resolved_transport()); "
                    "dune_psql.query_tsv('select 1;')"
                )
                result = self.run_seam(path_dir, program=program)
                self.assertQuerySucceeded(result)
                self.assertEqual(result.stdout.decode(), expected)
                self.assertEqual(
                    self.calls()[0],
                    "argv0=psql" if expected == "tcp" else "argv0=docker",
                )

    def test_reporting_the_transport_runs_no_query(self):
        program = "import dune_psql; dune_psql.resolved_transport()"
        self.assertQuerySucceeded(self.run_seam("with-psql", program=program))
        self.assertFalse(self.log.exists(), "reporting the transport queried the database")

    def test_a_typo_is_a_configuration_error(self):
        result = self.run_seam("with-psql", DUNE_PSQL_TRANSPORT="tpc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Invalid DUNE_PSQL_TRANSPORT=tpc", result.stderr)
        self.assertFalse(self.log.exists(), "a query ran despite the invalid setting")


class CommandLineTests(SeamTestCase):
    def test_the_exec_path_reproduces_the_argv_it_replaced(self):
        self.assertQuerySucceeded(self.run_seam("without-psql"))
        self.assertEqual(
            self.calls(),
            [
                "argv0=docker",
                "argc=12",
                "exec",
                "dune-postgres",
                "psql",
                "-U",
                "postgres",
                "-d",
                "dune",
                "-At",
                "-F",
                "\t",
                "-c",
                "select 1;",
                "PGPASSWORD=<unset>",
                "stdin=",
            ],
        )

    def test_the_tcp_path_dials_loopback_and_authenticates(self):
        self.assertQuerySucceeded(self.run_seam("with-psql"))
        self.assertEqual(
            self.calls(),
            [
                "argv0=psql",
                "argc=13",
                "-h",
                "127.0.0.1",
                "-p",
                "15432",
                "-U",
                "postgres",
                "-d",
                "dune",
                "-At",
                "-F",
                "\t",
                "-c",
                "select 1;",
                "PGPASSWORD=postgres",
                "stdin=",
            ],
        )

    def test_the_password_reaches_only_the_tcp_invocation(self):
        program = (
            "import dune_psql, os, sys; dune_psql.query_tsv('select 1;'); "
            "sys.stdout.write(os.environ.get('PGPASSWORD', '<unset>'))"
        )
        result = self.run_seam("with-psql", program=program)
        self.assertQuerySucceeded(result)
        self.assertEqual(result.stdout, b"<unset>")

    def test_the_caller_keeps_its_own_stdin(self):
        # The publishers query inside loops that read their own stdin, and a
        # psql opened over TCP is a direct child that would drain it. `docker
        # exec` without -i never attached stdin at all, so both paths have to
        # leave the caller's alone.
        for path_dir in ("with-psql", "without-psql"):
            with self.subTest(path_dir=path_dir):
                program = (
                    "import dune_psql, sys; dune_psql.query_tsv('select 1;'); "
                    "sys.stdout.write(sys.stdin.read())"
                )
                result = self.run_seam(path_dir, program=program, stdin=b"a\nb\nc\n")
                self.assertQuerySucceeded(result)
                self.assertIn("stdin=", self.calls())
                self.assertEqual(result.stdout, b"a\nb\nc\n")

    def test_a_failing_query_is_not_reported_as_empty_rows(self):
        # The argv lists this module replaced used check=True, and the callers
        # still parse whatever comes back line by line. A silently empty result
        # would read as "no partitions" and unpublish every map.
        directory = self.root / "without-psql"
        (directory / "docker").write_text("#!/usr/bin/env bash\nexit 3\n")
        (directory / "docker").chmod(0o755)
        result = self.run_seam("without-psql")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"CalledProcessError", result.stderr)


class PortTests(SeamTestCase):
    def test_a_configured_port_is_used_for_the_tcp_connection(self):
        self.assertQuerySucceeded(self.run_seam("with-psql", POSTGRES_PORT="25432"))
        self.assertIn("25432", self.calls())

    def test_an_empty_port_falls_back_to_the_shipped_default(self):
        self.assertQuerySucceeded(self.run_seam("with-psql", POSTGRES_PORT=""))
        self.assertIn("15432", self.calls())

    def test_an_unusable_port_is_refused_rather_than_defaulted_away(self):
        for value in ("99999", "0", "15432 ", "5432x"):
            with self.subTest(value=value):
                result = self.run_seam("with-psql", POSTGRES_PORT=value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    f"Invalid POSTGRES_PORT={value}".encode(), result.stderr
                )

    def test_the_port_does_not_reach_the_exec_path(self):
        # Addressing the container by name means the published port is not the
        # port psql connects to there, and passing it would break the one
        # transport that works before anything is published.
        self.assertQuerySucceeded(
            self.run_seam("without-psql", POSTGRES_PORT="25432")
        )
        self.assertNotIn("25432", self.calls())


class ResolutionTimingTests(SeamTestCase):
    def test_configuration_set_after_the_import_still_applies(self):
        # The publishers' shell prologues read .env and export the settings, but
        # a caller may also import the module first and configure afterwards.
        # Resolving at import time would pin the defaults before the operator's
        # values were ever visible.
        program = (
            "import dune_psql, os; os.environ['POSTGRES_PORT'] = '26432'; "
            "dune_psql.query_tsv('select 1;')"
        )
        self.assertQuerySucceeded(self.run_seam("with-psql", program=program))
        self.assertIn("26432", self.calls())

    def test_the_answer_is_settled_once_per_process(self):
        # The snapshot loops query many times per iteration. Neither answer can
        # change while a process runs, so re-deriving them -- a PATH search and a
        # port validation per query -- would be pure waste.
        program = (
            "import dune_psql, os; dune_psql.query_tsv('first');"
            "os.environ['POSTGRES_PORT'] = '26432';"
            "os.environ['DUNE_PSQL_TRANSPORT'] = 'exec';"
            "dune_psql.query_tsv('second')"
        )
        self.assertQuerySucceeded(self.run_seam("with-psql", program=program))
        calls = self.calls()
        self.assertEqual([line for line in calls if line.startswith("argv0=")],
                         ["argv0=psql", "argv0=psql"])
        self.assertNotIn("26432", calls)


class InterfaceTests(unittest.TestCase):
    def test_the_seam_offers_exactly_the_shape_its_callers_need(self):
        # Every converted call site wants unaligned tab-separated rows, which is
        # why query_tsv takes no argument passthrough. resolved_transport is the
        # one addition, and it exists for a caller that does not query at all:
        # doctor.sh reports which leg a running container would take. Anything
        # beyond these two is an abstraction nobody asked for.
        sys.path.insert(0, str(SCRIPTS))
        import dune_psql

        public = sorted(
            name for name in vars(dune_psql)
            if not name.startswith("_") and callable(getattr(dune_psql, name))
            and getattr(getattr(dune_psql, name), "__module__", None) == "dune_psql"
        )
        self.assertEqual(public, ["query_tsv", "resolved_transport"])

    def test_every_converted_publisher_reaches_the_module_the_same_way(self):
        # The publishers run as `python3 - <<PY` with the repository root as the
        # working directory, so the import needs that one sys.path entry and
        # nothing more. A block that forgot it would fail only in production.
        for name in (
            "publish-sietch-overrides.sh",
            "publish-deepdesert-overrides.sh",
            "publish-deepdesert-state.sh",
            "validate-sietch-state.sh",
        ):
            with self.subTest(script=name):
                text = (SCRIPTS / name).read_text()
                self.assertIn('sys.path.insert(0, "runtime/scripts")', text)
                self.assertEqual(
                    text.count("import dune_psql  # noqa: E402"),
                    text.count("import dune_psql"),
                )


if __name__ == "__main__":
    unittest.main()
