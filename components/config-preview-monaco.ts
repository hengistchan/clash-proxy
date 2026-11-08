import { editor, type Environment } from 'monaco-editor/editor.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';

export function mountPreviewEditor(container: HTMLElement, text: string, language: 'yaml' | 'ini') {
  const browser = globalThis as typeof globalThis & { MonacoEnvironment?: Environment };
  browser.MonacoEnvironment ??= {
    getWorker: () => new Worker(new URL('./config-preview.worker.ts', import.meta.url), { type: 'module' })
  };
  // The model has no file name or credentials in its URI.
  const model = editor.createModel(text, language);
  try {
    const instance = editor.create(container, {
      model,
      ariaLabel: '导出配置内容（只读）',
      readOnly: true,
      domReadOnly: true,
      editContext: false,
      automaticLayout: true,
      links: false,
      contextmenu: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      folding: false,
      renderLineHighlight: 'none',
      renderValidationDecorations: 'off',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      padding: { top: 8, bottom: 8 }
    });
    return {
      find() { void instance.getAction('actions.find')?.run(); },
      dispose() {
        instance.dispose();
        model.dispose();
      }
    };
  } catch (error) {
    model.dispose();
    throw error;
  }
}
