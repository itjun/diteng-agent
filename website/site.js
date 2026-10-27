(async () => {
  const status = document.querySelector('#release-status');
  try {
    const response = await fetch('release.json');
    if (!response.ok) throw new Error('release manifest unavailable');
    const release = await response.json();
    if (!release) {
      status.textContent = '正式版本尚未发布，发布后可在这里下载。';
      return;
    }
    status.textContent = `最新正式版：${release.version}`;
    for (const link of document.querySelectorAll('[data-asset]')) {
      const asset = release.assets.find((item) => item.name.endsWith(link.dataset.asset));
      if (asset) link.href = asset.url;
    }
  } catch {
    status.textContent = '版本信息暂时不可用，请前往 GitHub Releases 查看。';
  }
})();
