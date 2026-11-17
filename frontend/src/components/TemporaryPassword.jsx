import { useState } from 'react';

/**
 * Shows a newly issued login once: username + temporary password, with a
 * copy button. The password is not stored in the clear anywhere, so it
 * cannot be shown again; a new one can be issued with "Reset password".
 */
export function TemporaryPassword({ account, who = 'They' }) {
  const [copied, setCopied] = useState(false);
  if (!account) return null;
  const text = `Cevruni sign-in\nUsername: ${account.login}\nTemporary password: ${account.temporaryPassword}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="temp-password" role="status">
      <div>
        <div className="cell-sub">Username</div>
        <code>{account.login}</code>
      </div>
      <div>
        <div className="cell-sub">Temporary password</div>
        <code>{account.temporaryPassword}</code>
      </div>
      <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <p className="hint" style={{ flexBasis: '100%', margin: 0 }}>
        Shown only now. {who} must change it the first time they sign in.
      </p>
    </div>
  );
}
