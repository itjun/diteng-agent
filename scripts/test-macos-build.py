"""本机构建预检回归：python3 scripts/test-macos-build.py。"""

from contextlib import ExitStack
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("local_build", Path(__file__).resolve().parents[1] / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class MacOSBuildTests(unittest.TestCase):
    def run_build(self, selected_developer, installed_apps, available_developer):
        def probe(command, **kwargs):
            self.assertEqual(command, ["xcrun", "--find", "actool"])
            developer = kwargs.get("env", os.environ).get("DEVELOPER_DIR", selected_developer)
            if developer == available_developer:
                return subprocess.CompletedProcess(command, 0, stdout=f"{developer}/usr/bin/actool\n", stderr="")
            if kwargs.get("check"):
                raise subprocess.CalledProcessError(72, command)
            return subprocess.CompletedProcess(command, 72, stdout="", stderr='xcrun: unable to find utility "actool"')

        with ExitStack() as stack:
            stack.enter_context(patch.object(build.sys, "argv", ["build.py", "--no-launch"]))
            stack.enter_context(patch.object(build.sys, "platform", "darwin"))
            stack.enter_context(patch.object(build.platform, "machine", return_value="arm64"))
            stack.enter_context(patch.object(build.shutil, "which", return_value="/test/tool"))
            stack.enter_context(patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE": "1"}, clear=True))
            stack.enter_context(patch.object(build.Path, "glob", side_effect=lambda pattern: iter(installed_apps)))
            stack.enter_context(patch.object(build.Path, "exists", return_value=False))
            stack.enter_context(patch.object(build.Path, "is_dir", return_value=True))
            stack.enter_context(patch.object(build.subprocess, "run", side_effect=probe))
            stack.enter_context(patch("builtins.print"))
            commands = stack.enter_context(patch.object(build, "run"))
            stopped = stack.enter_context(patch.object(build, "stop_running"))
            installed = stack.enter_context(patch.object(build, "install"))
            try:
                build.main()
            except BaseException:
                stopped.assert_not_called()
                installed.assert_not_called()
                raise
            stopped.assert_called_once()
            installed.assert_called_once()
            return commands.call_args_list

    def test_clt_selection_finds_installed_xcode_and_passes_it_to_builder(self):
        app = Path("/Applications/Xcode 27.app")
        developer = str(app / "Contents/Developer")
        commands = self.run_build("/Library/Developer/CommandLineTools", [app], developer)
        builder = next(call for call in commands if "electron-builder" in call.args)
        self.assertEqual(builder.kwargs["env"]["DEVELOPER_DIR"], developer)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", builder.kwargs["env"])
        clang = next(call for call in commands if call.args == ("xcrun", "--find", "clang"))
        self.assertEqual(clang.kwargs["env"]["DEVELOPER_DIR"], developer)

    def test_selected_xcode_is_used_before_other_installations(self):
        developer = "/Volumes/Developer Tools/Xcode.app/Contents/Developer"
        commands = self.run_build(developer, [Path("/Applications/Xcode.app")], developer)
        builder = next(call for call in commands if "electron-builder" in call.args)
        self.assertEqual(builder.kwargs["env"]["DEVELOPER_DIR"], developer)

    def test_missing_xcode_reports_dependency_before_stopping_app(self):
        with self.assertRaisesRegex(RuntimeError, "Xcode.*26.*DEVELOPER_DIR"):
            self.run_build("/Library/Developer/CommandLineTools", [], "/missing/Xcode.app/Contents/Developer")


if __name__ == "__main__":
    unittest.main()
