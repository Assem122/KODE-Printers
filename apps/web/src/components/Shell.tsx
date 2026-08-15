import type { ReactElement, ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import {
  AdminIcon,
  BellIcon,
  FleetIcon,
  HistoryIcon,
  InsightIcon,
  KodeMark,
  PrintIcon,
  ScanIcon,
} from './ui.js';

/**
 * Application chrome.
 *
 * Two navigations, one source of truth. A collapsed icon rail on desktop keeps
 * the working area wide — the fleet board and the job table are the screens
 * people live in, and a 248px sidebar costs a table column. On phones the same
 * list becomes a bottom bar, because this app is opened one-handed while
 * standing next to a printer.
 *
 * Admin-only destinations are filtered out of the array rather than rendered
 * disabled: a user should not be shown a door they cannot open.
 */

interface Destination {
  to: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
  /** Shown in the bottom bar. The rail shows everything. */
  primary?: boolean;
}

const DESTINATIONS: readonly Destination[] = [
  { to: '/print', label: 'Print', icon: <PrintIcon />, primary: true },
  { to: '/fleet', label: 'Printers', icon: <FleetIcon />, primary: true },
  { to: '/scans', label: 'Scans', icon: <ScanIcon />, primary: true },
  { to: '/jobs', label: 'History', icon: <HistoryIcon />, primary: true },
  { to: '/insights', label: 'Insights', icon: <InsightIcon /> },
  { to: '/admin', label: 'Admin', icon: <AdminIcon />, adminOnly: true },
];

export function Shell(): ReactElement {
  const { isAdmin } = useAuth();
  const visible = DESTINATIONS.filter((entry) => !entry.adminOnly || isAdmin);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    // The SSE stream invalidates this on every new notification, so the interval
    // is only a safety net for a dropped stream rather than the primary path.
    refetchInterval: 120_000,
    staleTime: 30_000,
  });

  const unreadCount = unread?.count ?? 0;

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <NavLink to="/print" className="rail__brand" aria-label="KODE Printer home">
          <KodeMark size={26} title="KODE Printer" />
        </NavLink>

        {visible.map((entry) => (
          <NavLink key={entry.to} to={entry.to} className="nav-item">
            {entry.icon}
            <span className="nav-item__label">{entry.label}</span>
          </NavLink>
        ))}

        <div className="rail__spacer" />

        <NavLink to="/notifications" className="nav-item">
          <BellIcon />
          {unreadCount > 0 ? (
            <span className="nav-item__badge" aria-hidden="true">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
          <span className="nav-item__label">
            Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}
          </span>
        </NavLink>

        <NavLink to="/account" className="nav-item">
          <Avatar />
          <span className="nav-item__label">Account</span>
        </NavLink>
      </nav>

      <main className="shell__main">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {visible
          .filter((entry) => entry.primary)
          .map((entry) => (
            <NavLink key={entry.to} to={entry.to} className="bottom-nav__item">
              {entry.icon}
              {entry.label}
            </NavLink>
          ))}
        <NavLink to="/notifications" className="bottom-nav__item">
          <span style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
            <BellIcon />
            {unreadCount > 0 ? (
              <span className="nav-item__badge" style={{ top: -4, right: -6 }} aria-hidden="true">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            ) : null}
          </span>
          Alerts
        </NavLink>
      </nav>
    </div>
  );
}

function Avatar(): ReactElement {
  const { user } = useAuth();
  const initials = (user?.displayName ?? user?.username ?? '?')
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <span
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 30,
        height: 30,
        borderRadius: 'var(--radius-pill)',
        background: 'var(--kode-blue)',
        color: '#fff',
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.02em',
      }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
