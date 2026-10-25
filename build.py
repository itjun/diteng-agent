#!/usr/bin/env python3
"""本机重新部署（macOS）：停止旧进程 → 编译打包 → 安装 → 启动。

用法：./build.py（main）或 ./build.py --env dev；--no-launch 安装后不启动。
依赖：Python 3、Node.js、pnpm 和 Xcode Command Line Tools。
"""

import argparse
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time


PROJECT_ROOT = Path(__file__).resolve().parent
APP_NAME = "diteng agent"
INSTALL_APP = Path("/Applications") / f"{APP_NAME}.app"
LSREGISTER = (
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    "LaunchServices.framework/Support/lsregister"
)


def run(*args, env=None):
    print(f"==> {' '.join(str(arg) for arg in args)}", flush=True)
    subprocess.run(
        [str(arg) for arg in args], cwd=PROJECT_ROOT, env=env, check=True,
    )


def running_pids():
    """只匹配安装副本、本仓库 release 副本及本仓库开发用 Electron。"""
    result = subprocess.run(
        ["ps", "-axo", "pid=,comm="], check=True, capture_output=True, text=True,
    )
    pids = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        pid, executable = fields
        is_installed = executable.startswith(f"{INSTALL_APP}/Contents/")
        is_packaged = (
            executable.startswith(f"{PROJECT_ROOT}/release/")
            and f"/{APP_NAME}.app/Contents/" in executable
        )
        is_development = (
            executable.startswith(f"{PROJECT_ROOT}/node_modules/")
            and "/Electron.app/Contents/" in executable
        )
        if is_installed or is_packaged or is_development:
            pids.append(int(pid))
    return pids


def stop_running():
    pids = running_pids()
    if not pids:
        print("==> 没有正在运行的旧应用", flush=True)
        return
    print(f"==> 停止旧应用（PID: {', '.join(map(str, pids))}）", flush=True)
    deadline = time.monotonic() + 10
    while pids:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.1)
        pids = running_pids()
        if pids and time.monotonic() >= deadline:
            raise RuntimeError("旧应用未能退出，已中止安装")


def install(app_bundle):
    # 在同一卷暂存并校验，完成后再替换；不修改用户的登录信息和配置。
    staging = Path(tempfile.mkdtemp(prefix=".diteng-agent-install-", dir=INSTALL_APP.parent))
    staged_app = staging / INSTALL_APP.name
    previous_app = staging / "previous.app"
    try:
        run("ditto", app_bundle, staged_app)
        run("codesign", "--verify", "--deep", "--strict", staged_app)
        # 构建期间用户可能重新打开应用，替换前再检查一次。
        stop_running()
        if INSTALL_APP.exists():
            INSTALL_APP.rename(previous_app)
        try:
            staged_app.rename(INSTALL_APP)
        except OSError:
            if previous_app.exists():
                previous_app.rename(INSTALL_APP)
            raise
    except BaseException:
        if previous_app.exists() and not INSTALL_APP.exists():
            print(f"旧版本保留在：{previous_app}", file=sys.stderr)
        else:
            shutil.rmtree(staging)
        raise
    else:
        shutil.rmtree(staging)
    run(LSREGISTER, "-f", INSTALL_APP)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=("main", "dev"), default="main", help="打包环境（默认 main）")
    parser.add_argument("--no-launch", action="store_true", help="安装后不启动应用")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("本机自动安装目前仅支持 macOS；Windows 请使用 pnpm dist:win")
    architecture = {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if not architecture:
        parser.error(f"不支持的处理器架构：{platform.machine()}")
    for tool in ("node", "pnpm", "ps", "ditto", "codesign", "open", "xcrun"):
        if shutil.which(tool) is None:
            parser.error(f"未找到 {tool}，请先安装依赖并加入 PATH")
    run("xcrun", "--find", "clang")

    started = time.monotonic()
    stop_running()
    run("pnpm", "install", "--frozen-lockfile")
    run("pnpm", "typecheck")
    # 只清编译输出，保留 release 中其他版本的安装包。
    for directory in (PROJECT_ROOT / "dist", PROJECT_ROOT / "release" / (
        "mac-arm64" if architecture == "arm64" else "mac"
    )):
        if directory.exists():
            shutil.rmtree(directory)
    run("pnpm", "build:dev" if args.env == "dev" else "build")
    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    run(
        "pnpm", "exec", "electron-builder", "--mac", f"--{architecture}",
        "--config.mac.identity=-", "--publish", "never", env=env,
    )
    output_directory = "mac-arm64" if architecture == "arm64" else "mac"
    app_bundle = PROJECT_ROOT / "release" / output_directory / INSTALL_APP.name
    if not app_bundle.is_dir():
        raise RuntimeError(f"未找到打包产物：{app_bundle}")
    print(f"==> 安装到 {INSTALL_APP}", flush=True)
    install(app_bundle)
    if not args.no_launch:
        run("open", INSTALL_APP)
    print(
        f"==> 完成，耗时 {time.monotonic() - started:.1f}s；"
        f"安装包位于 {PROJECT_ROOT / 'release'}", flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"构建安装失败：{exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已取消构建安装", file=sys.stderr)
        sys.exit(130)
