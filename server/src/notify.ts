import { execFile } from 'node:child_process';
import { config } from './config.js';

// Native Windows toast through PowerShell's built-in WinRT access, so nothing extra has to be installed.
// Title, text and link travel as environment variables and are XML-escaped inside PowerShell, so no
// message text is ever parsed as script. Clicking the toast opens the dashboard (protocol activation).
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$e = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = @"
<toast activationType="protocol" launch="$(& $e $env:MP_LINK)" duration="long">
  <visual><binding template="ToastGeneric">
    <text>$(& $e $env:MP_TITLE)</text>
    <text>$(& $e $env:MP_BODY)</text>
  </binding></visual>
  <actions><action content="Open dashboard" activationType="protocol" arguments="$(& $e $env:MP_LINK)" /></actions>
</toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;

export const desktopNotificationsAvailable = () => process.platform === 'win32' && config.desktopNotifications;

/** Shows a Windows notification. Does nothing on other systems (e.g. Vercel) or when turned off in .env. */
export function notifyDesktop(title: string, body: string, page = 'sending'): Promise<void> {
  if (!desktopNotificationsAvailable()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, MP_TITLE: title, MP_BODY: body.slice(0, 300), MP_LINK: `${config.dashboardUrl}/#/${page}` },
      },
      (err, _stdout, stderr) => {
        if (err) {
          const reason = stderr.trim().split('\n')[0] || err.message;
          console.error('[notify]', reason);
          reject(new Error(`Windows notification failed: ${reason}`));
        } else resolve();
      },
    );
  });
}
