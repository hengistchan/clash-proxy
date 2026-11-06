'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react';

interface DraftState {
  dirty: boolean;
  busy: boolean;
  onDiscard?: () => void;
}

interface DraftEntry {
  current: DraftState;
}

/** Keep the decision synchronous so every navigation uses the same draft state. */
export function confirmDrafts(
  drafts: DraftState[],
  confirm: (message: string) => boolean,
  inform: (message: string) => void
): boolean {
  if (drafts.some((draft) => draft.busy)) {
    inform('正在保存，请等待保存完成后再离开。');
    return false;
  }
  const changed = drafts.filter((draft) => draft.dirty);
  if (changed.length && !confirm('有尚未保存的修改。要放弃这些修改并继续吗？')) {
    return false;
  }
  changed.forEach((draft) => draft.onDiscard?.());
  return true;
}

const DraftContext = createContext<{
  register: (entry: DraftEntry) => () => void;
  confirmNavigation: () => boolean;
} | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Set<DraftEntry>());
  const register = useCallback((entry: DraftEntry) => {
    drafts.current.add(entry);
    return () => {
      drafts.current.delete(entry);
    };
  }, []);
  const confirmNavigation = useCallback(
    () =>
      confirmDrafts(
        Array.from(drafts.current, (entry) => entry.current),
        (message) => window.confirm(message),
        (message) => window.alert(message)
      ),
    []
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
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const value = useMemo(
    () => ({ register, confirmNavigation }),
    [register, confirmNavigation]
  );
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useNavigationGuard() {
  const context = useContext(DraftContext);
  if (!context) throw new Error('Navigation guard requires UnsavedChangesProvider');
  return { confirmNavigation: context.confirmNavigation };
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
    () =>
      confirmDrafts(
        [entry.current],
        (message) => window.confirm(message),
        (message) => window.alert(message)
      ),
    []
  );
  return { confirmDiscard };
}
