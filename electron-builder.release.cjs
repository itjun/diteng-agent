module.exports = {
  extends: './electron-builder.yml',
  artifactName: 'diteng-agent-${version}-${os}-${arch}.${ext}',
  publish: { provider: 'github', owner: 'itjun', repo: 'diteng-agent', releaseType: 'draft' },
  mac: {
    // CI 通用 ICNS 不依赖 runner 预选的 Xcode；本机构建继续使用原生分层图标。
    icon: 'build/icon.icns',
    // 目前发布免开发者签名的安装包，后续取得证书后再恢复签名与公证。
    identity: null,
    hardenedRuntime: false,
    notarize: false,
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
  },
  linux: {
    executableName: 'diteng-agent', category: 'Office', icon: 'build/icon.png',
    maintainer: 'itjun <l1091462907@gmail.com>',
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }],
  },
};
