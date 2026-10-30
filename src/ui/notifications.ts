export type NotificationAccess = NotificationPermission | 'unsupported';

function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationAccess(): NotificationAccess {
  return isSupported() ? Notification.permission : 'unsupported';
}

/** Must be called from a user gesture; browsers ignore or penalise prompts that are not. */
export async function requestNotificationAccess(): Promise<NotificationAccess> {
  if (!isSupported()) {
    return 'unsupported';
  }
  return Notification.requestPermission();
}

export interface BrowserNotificationOptions {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag: string;
  onSelect: () => void;
}

export function showBrowserNotification({
  title,
  body,
  tag,
  onSelect,
}: BrowserNotificationOptions): void {
  if (getNotificationAccess() !== 'granted') {
    return;
  }
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onSelect();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app toast still shows.
  }
}
