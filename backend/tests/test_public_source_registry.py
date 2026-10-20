"""The live scheduler and source catalog include every newly authorized feed."""
import ast
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

APP = Path(__file__).resolve().parents[1] / "app"
spec = importlib.util.spec_from_file_location("public_sources_registry", APP / "public_sources.py")
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)


class PublicSourceRegistryTests(unittest.TestCase):
    def test_scheduler_intervals_and_lazy_jobs_use_distinct_provider_functions(self):
        tree = ast.parse((APP / "main.py").read_text(encoding="utf-8-sig"))
        interval = next(node for node in tree.body if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "SERVICE_REFRESH_INTERVALS")
        factory = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_external_risks_fetch_jobs")
        fetchers = {key: Mock(return_value={"service": key}) for key in public.FETCHERS}
        namespace = {"PUBLIC_SOURCE_DEFINITIONS": public.DEFINITIONS, "PUBLIC_SOURCE_FETCHERS": fetchers}
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, interval, factory], type_ignores=[])), "registry", "exec"), namespace)
        jobs = namespace["build_external_risks_fetch_jobs"](True, [])
        for key, fetch in fetchers.items():
            with self.subTest(key=key):
                fetch.assert_not_called()
                self.assertEqual(namespace["SERVICE_REFRESH_INTERVALS"][key], public.DEFINITIONS[key]["interval"])
                collect, fallback = jobs[key]
                self.assertEqual(fallback["status"], "pending")
                self.assertEqual(collect(), {"service": key})
                fetch.assert_called_once_with(force_refresh=True)


if __name__ == '__main__':
    unittest.main()
