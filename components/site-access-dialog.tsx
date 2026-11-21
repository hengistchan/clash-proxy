'use client';

import { useEffect, useState } from 'react';
import { SITE_ACCESS_REQUIRED } from './api-client';
import { Modal } from './ui';

export function SiteAccessDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SITE_ACCESS_REQUIRED, show);
    return () => window.removeEventListener(SITE_ACCESS_REQUIRED, show);
  }, []);

  return <Modal open={open} onOpenChange={setOpen} title="需要重新登录站点"
    description="站点访问网关拦截了此请求。请在新标签页完成登录，回到这里后手动重试。"
    footer={<>
      <button type="button" className="button secondary" onClick={() => setOpen(false)}>返回工作台</button>
      <a className="button primary" href="/" target="_blank" rel="noopener noreferrer">打开站点重新登录</a>
    </>}>
    <p className="delivery-note">当前页面和未保存的输入会保留，工作台不会自动重发刚才的操作。</p>
  </Modal>;
}
