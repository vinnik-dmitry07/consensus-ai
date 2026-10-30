import { useEffect, useState } from 'react';
import CopyButton from './CopyButton';
import { deleteShare, isLocalShareBase, shareConversation } from '../share/index.js';
import { DEFAULT_DPASTE_EXPIRY_DAYS, DPASTE_EXPIRY_DAYS } from '../share/providers.js';
import { forgetShareLink, getGithubToken, listShareLinks } from '../share/settings.js';
import './ShareDialog.css';

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function providerLabel(provider) {
  return provider === 'gist' ? 'GitHub Gist' : 'dpaste.com';
}

function linksFor(conversation) {
  if (!conversation.id) return [];
  return listShareLinks(conversation.id);
}

export default function ShareDialog({ conversation, locked = false, onClose }) {
  const hasToken = Boolean(getGithubToken());
  const [provider, setProvider] = useState(hasToken ? 'gist' : 'dpaste');
  const [expiryDays, setExpiryDays] = useState(DEFAULT_DPASTE_EXPIRY_DAYS);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [createdLink, setCreatedLink] = useState('');
  const [links, setLinks] = useState(() => linksFor(conversation));
  const localLink = typeof window !== 'undefined' && isLocalShareBase(window.location);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => {
    setLinks(linksFor(conversation));
  };

  const handleForget = (item) => {
    forgetShareLink(item.provider, item.id);
    refresh();
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const record = await shareConversation(conversation, {
        provider,
        expiryDays,
        includeAttachments,
      });
      setCreatedLink(record.link);
      refresh();
      if (record.remembered === false) {
        setError('The link is ready, but this browser could not keep it in the list. Copy it now.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a share link.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item) => {
    setBusy(true);
    setError(null);
    try {
      await deleteShare(item.provider, item.id);
      const marker = `share=${item.provider}:${item.id}`;
      if (createdLink.includes(marker)) setCreatedLink('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this share.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-overlay" onClick={onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="share-dialog-header">
          <h2 id="share-dialog-title">Share conversation</h2>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form className="share-dialog-body" onSubmit={handleCreate}>
          <p className="share-note">
            Anyone with the full link can read this conversation. The key stays in the
            link after # and is not uploaded. This browser keeps a copy of each link,
            including the key, so you can copy it again. A dpaste link cannot be revoked
            before it expires. A Gist link can be deleted here. GitHub shows the account
            that created a gist, and anyone with the gist id can download the encrypted file.
          </p>
          {locked && (
            <p className="share-note share-note-warn">
              Wait until the current answer finishes before creating a link.
            </p>
          )}
          {localLink && (
            <p className="share-note share-note-warn">
              This link uses this computer&apos;s address. Someone else cannot open it.
            </p>
          )}
          <fieldset className="share-providers">
            <legend>Where to store the encrypted copy</legend>
            <label>
              <input
                type="radio"
                name="share-provider"
                value="gist"
                checked={provider === 'gist'}
                disabled={!hasToken || busy}
                onChange={() => setProvider('gist')}
              />
              <span>{providerLabel('gist')} (secret)</span>
            </label>
            {!hasToken && (
              <p className="share-hint">Add a GitHub token in Settings to use Gist.</p>
            )}
            <label>
              <input
                type="radio"
                name="share-provider"
                value="dpaste"
                checked={provider === 'dpaste'}
                disabled={busy}
                onChange={() => setProvider('dpaste')}
              />
              <span>{providerLabel('dpaste')}</span>
            </label>
          </fieldset>
          {provider === 'dpaste' && (
            <label className="share-expiry">
              <span>Expires</span>
              <select
                value={expiryDays}
                disabled={busy}
                onChange={(event) => setExpiryDays(Number(event.target.value))}
              >
                {DPASTE_EXPIRY_DAYS.map((days) => (
                  <option key={days} value={days}>{days} days</option>
                ))}
              </select>
            </label>
          )}
          <label className="share-attachments">
            <input
              type="checkbox"
              checked={includeAttachments}
              disabled={busy}
              onChange={(event) => setIncludeAttachments(event.target.checked)}
            />
            <span>Include attachments</span>
          </label>
          {error && <div className="share-error" role="alert">{error}</div>}
          <div className="share-actions">
            <button
              type="submit"
              className="share-create-button"
              disabled={busy || locked || (provider === 'gist' && !hasToken)}
            >
              {busy ? 'Working...' : 'Create link'}
            </button>
          </div>
          {createdLink && (
            <div className="share-result">
              <input
                className="share-link-input"
                readOnly
                value={createdLink}
                aria-label="Share link"
                onFocus={(event) => event.target.select()}
              />
              <CopyButton text={createdLink} label="Copy link" />
            </div>
          )}
          {links.length > 0 && (
            <ul className="share-link-list">
              {links.map((item) => {
                const expiry = formatWhen(item.expires_at);
                return (
                  <li key={`${item.provider}:${item.id}`}>
                    <div className="share-link-meta">
                      <strong>{providerLabel(item.provider)}</strong>
                      <span>{item.id}</span>
                      {expiry && <span>Expires {expiry}</span>}
                    </div>
                    <div className="share-link-actions">
                      <CopyButton text={item.link} label="Copy link" />
                      {item.provider === 'gist' ? (
                        <button
                          type="button"
                          className="share-delete-button"
                          onClick={() => handleDelete(item)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="share-delete-button"
                          onClick={() => handleForget(item)}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </form>
      </div>
    </div>
  );
}
