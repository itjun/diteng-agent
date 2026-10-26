const isPublishing = process.env.RELEASE_PUBLISH === 'true';
if (isPublishing && process.platform === 'darwin') {
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[key]) throw new Error(`正式 macOS 发布缺少 ${key}`);
  }
}

module.exports = {
  extends: './electron-builder.yml',
  artifactName: 'diteng-agent-${version}-${os}-${arch}.${ext}',
  publish: { provider: 'github', owner: 'itjun', repo: 'diteng-agent', releaseType: 'draft' },
  mac: {
    // CI 通用 ICNS 不依赖 runner 预选的 Xcode；本机构建继续使用原生分层图标。
    icon: 'build/icon.icns',
    identity: isPublishing ? process.env.CSC_NAME : null,
    hardenedRuntime: isPublishing,
    notarize: isPublishing,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
  },
  linux: {
    executableName: 'diteng-agent', category: 'Office', icon: 'build/icon.png',
    maintainer: 'itjun <l1091462907@gmail.com>',
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }],
  },
};
