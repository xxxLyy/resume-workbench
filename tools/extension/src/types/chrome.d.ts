// Chrome 扩展 API 的最小类型面：只声明本扩展用到的子集（不加 @types/chrome
// 依赖——扩展零运行时依赖的纪律顺带覆盖类型层）。用到新 API 时在此补声明。
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; url?: string };
      id?: string;
      url?: string;
    }
    interface OnMessageEvent {
      addListener(
        cb: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    }
    const onMessage: OnMessageEvent;
    interface OnInstalledEvent {
      addListener(cb: (details: { reason: string }) => void): void;
    }
    const onInstalled: OnInstalledEvent;
    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(
      message: unknown,
      callback: (response: unknown) => void,
    ): void;
    function getURL(path: string): string;
    const lastError: { message?: string } | undefined;
  }

  namespace storage {
    interface StorageArea {
      get(keys: string[] | string | null): Promise<Record<string, unknown>>;
      get(
        keys: string[] | string | null,
        cb: (items: Record<string, unknown>) => void,
      ): void;
      set(items: Record<string, unknown>): Promise<void>;
      set(items: Record<string, unknown>, cb: () => void): void;
    }
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      active?: boolean;
      status?: string;
      windowId?: number;
    }
    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      url?: string | string[];
    }
    function query(info: QueryInfo): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function sendMessage(
      tabId: number,
      message: unknown,
      callback: (response: unknown) => void,
    ): void;
    function update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab>;
    function create(props: { url?: string; active?: boolean }): Promise<Tab>;
    function reload(tabId: number): Promise<void>;
    interface OnUpdatedEvent {
      addListener(
        cb: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
    }
    const onUpdated: OnUpdatedEvent;
    const TAB_ID_NONE: number;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: {
      openPanelOnActionClick?: boolean;
    }): Promise<void>;
    function open(options: { tabId?: number; windowId?: number }): Promise<void>;
  }

  namespace action {
    interface OnClickedEvent {
      addListener(cb: (tab: tabs.Tab) => void): void;
    }
    const onClicked: OnClickedEvent;
  }
}
