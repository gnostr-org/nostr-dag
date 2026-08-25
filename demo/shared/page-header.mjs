function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render the shared page header and navigation bar used by the demo and Git viewer.
 * Keep the page-specific content below this shared chrome so both entry points stay aligned.
 */
export function createSharedHeader(root, options = {}) {
  if (!root) {
    return {
      render() {},
    };
  }

  const title = options.title || 'bitcoin-pages';
  const subtitleHtml = options.subtitleHtml || '';
  const logoHref = options.logoHref || '#';
  const iconHref = options.iconHref || './shared/favicon.ico';
  const navItems = Array.isArray(options.navItems) ? options.navItems : [];

  root.classList.add('sticky-header');
  root.innerHTML = `
    <div class="header-container">
      <nav class="header-nav" aria-label="Primary navigation">
        <div class="header-brand">
          <a href="${escapeHtml(logoHref)}"><img class="brand-icon" src="${escapeHtml(iconHref)}" alt="" aria-hidden="true" /><span class="logo-text">${escapeHtml(title)}</span></a>
          ${subtitleHtml ? `<div class="muted header-subtitle">${subtitleHtml}</div>` : ''}
        </div>
        ${navItems.length ? `
          <ul class="nav-links">
            ${navItems
              .map((item) => {
                const label = escapeHtml(item.label || '');
                const href = escapeHtml(item.href || '#');
                const current = item.current ? ' aria-current="page"' : '';
                return `<li><a class="nav-link${item.current ? ' current' : ''}" href="${href}"${current}>${label}</a></li>`;
              })
              .join('')}
          </ul>
        ` : ''}
      </nav>
    </div>
  `;

  return {
    render() {},
  };
}
