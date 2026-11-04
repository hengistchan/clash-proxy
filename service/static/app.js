(() => {
  const form = document.querySelector('#config-form');
  const urlInput = document.querySelector('#glados-url');
  const revealButton = document.querySelector('#reveal-url');
  const generateButton = document.querySelector('#generate-button');
  const templateLabel = document.querySelector('#template-label');
  const result = document.querySelector('#result');
  const resultTitle = document.querySelector('#result-title');
  const resultDetail = document.querySelector('#result-detail');
  const errorBox = document.querySelector('#error');

  function selectedTemplate() {
    return form.querySelector('input[name="template"]:checked').value;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    result.hidden = true;
  }

  function clearNotices() {
    errorBox.hidden = true;
    result.hidden = true;
  }

  function parseFilename(disposition) {
    const match = disposition && disposition.match(/filename="([^"]+)"/i);
    return match ? match[1] : 'hj-stash.yaml';
  }

  function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  }

  revealButton.addEventListener('click', () => {
    const showing = urlInput.type === 'text';
    urlInput.type = showing ? 'password' : 'text';
    revealButton.setAttribute('aria-pressed', String(!showing));
    revealButton.setAttribute('aria-label', showing ? '显示订阅地址' : '隐藏订阅地址');
  });

  form.querySelectorAll('input[name="template"]').forEach((input) => {
    input.addEventListener('change', () => {
      templateLabel.textContent = selectedTemplate() === 'no_ads' ? 'NO ADS' : 'PRODUCTION';
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotices();

    if (!urlInput.reportValidity()) {
      return;
    }

    generateButton.disabled = true;
    generateButton.querySelector('span').textContent = '正在生成…';

    try {
      const response = await fetch('/api', {
        method: 'POST',
        headers: {
          'Accept': 'application/yaml, application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: urlInput.value,
          template: selectedTemplate()
        })
      });

      if (!response.ok) {
        let message = '生成失败，请检查订阅地址后重试。';
        try {
          const payload = await response.json();
          if (typeof payload.detail === 'string') {
            message = payload.detail;
          }
        } catch (_error) {
          // Keep the generic message when an upstream proxy returns non-JSON.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const filename = parseFilename(response.headers.get('Content-Disposition'));
      const checksum = response.headers.get('X-Config-SHA256') || 'unknown';
      downloadBlob(blob, filename);

      resultTitle.textContent = '配置已生成并开始下载';
      resultDetail.textContent = `${filename} · ${blob.size.toLocaleString()} bytes · SHA-256 ${checksum}`;
      result.hidden = false;
    } catch (error) {
      showError(error instanceof Error ? error.message : '生成失败，请稍后重试。');
    } finally {
      generateButton.disabled = false;
      generateButton.querySelector('span').textContent = '锻造完整配置';
    }
  });
})();
