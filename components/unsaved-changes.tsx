'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

import { Modal } from './ui';

interface DraftState {
  dirty: boolean;
  busy: boolean;
  onDiscard?: () => void;
}

interface DraftEntry {
  current: DraftState;
}

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

type Confirm = (message: string, options?: ConfirmOptions) => Promise<boolean>;
type Inform = (message: string) => void;

/** Keep the decision sequential so every navigation uses the same draft state. */
export async function confirmDrafts(
  drafts: DraftState[],
  confirm: Confirm,
  inform: Inform
): Promise<boolean> {
  if (drafts.some((draft) => draft.busy)) {
    inform('正在保存，请等待保存完成后再离开。');
    return false;
  }
  const changed = drafts.filter((draft) => draft.dirty);
  if (
    changed.length &&
    !(await confirm('有尚未保存的修改。要放弃这些修改并继续吗？', {
      title: '放弃未保存的修改？',
      confirmLabel: '放弃修改'
    }))
  ) {
    return false;
  }
  changed.forEach((draft) => draft.onDiscard?.());
  return true;
}

interface PromptState extends ConfirmOptions {
  message: string;
  resolve: (value: boolean) => void;
}

const DraftContext = createContext<{
  register: (entry: DraftEntry) => () => void;
  confirmNavigation: () => Promise<boolean>;
  confirm: Confirm;
  inform: Inform;
} | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Set<DraftEntry>());
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const promptRef = useRef<PromptState | null>(null);

  const register = useCallback((entry: DraftEntry) => {
    drafts.current.add(entry);
    return () => {
      drafts.current.delete(entry);
    };
  }, []);

  const confirm = useCallback<Confirm>(
    (message, options = {}) =>
      new Promise<boolean>((resolve) => {
        const next = { message, ...options, resolve };
        promptRef.current = next;
        setPrompt(next);
      }),
    []
  );

  const settle = useCallback((value: boolean) => {
    const current = promptRef.current;
    promptRef.current = null;
    setPrompt(null);
    current?.resolve(value);
  }, []);

  const inform = useCallback<Inform>((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5200);
  }, []);

  const confirmNavigation = useCallback(
    () =>
      confirmDrafts(
        Array.from(drafts.current, (entry) => entry.current),
        confirm,
        inform
      ),
    [confirm, inform]
  );

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      const pending = Array.from(drafts.current).some(
        (entry) => entry.current.dirty || entry.current.busy
      );
      if (!pending) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const value = useMemo(
    () => ({ register, confirmNavigation, confirm, inform }),
    [register, confirmNavigation, confirm, inform]
  );
  return (
    <DraftContext.Provider value={value}>
      {children}
      <Modal
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        title={prompt?.title ?? '确认操作'}
        description={prompt?.message}
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => settle(false)}
            >
              {prompt?.cancelLabel ?? '取消'}
            </button>
            <button
              className={prompt?.tone === 'danger' ? 'button danger' : 'button primary'}
              onClick={() => settle(true)}
            >
              {prompt?.confirmLabel ?? '继续'}
            </button>
          </>
        }
      >
        <p className="delivery-note">确认后将继续当前操作。</p>
      </Modal>
      {notice ? (
        <div className="toast toast-bad" role="alert">
          <span>{notice}</span>
        </div>
      ) : null}
    </DraftContext.Provider>
  );
}

export function useNavigationGuard() {
  const context = useContext(DraftContext);
  if (!context) throw new Error('Navigation guard requires UnsavedChangesProvider');
  return { confirmNavigation: context.confirmNavigation };
}

export function useConfirm() {
  const context = useContext(DraftContext);
  if (!context) throw new Error('Confirmation requires UnsavedChangesProvider');
  return { confirm: context.confirm, inform: context.inform };
}

export function useUnsavedChanges(
  dirty: boolean,
  busy = false,
  onDiscard?: () => void
) {
  const context = useContext(DraftContext);
  const entry = useRef<DraftState>({ dirty, busy, onDiscard });
  entry.current = { dirty, busy, onDiscard };
  useEffect(() => context?.register(entry), [context]);
  const confirmDiscard = useCallback(
    () => confirmDrafts([entry.current], context!.confirm, context!.inform),
    [context]
  );
  return { confirmDiscard };
}
