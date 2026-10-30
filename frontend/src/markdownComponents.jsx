import remarkGfm from 'remark-gfm';

export const remarkGfmPlugin = remarkGfm;

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;

function shareHref(href) {
  if (typeof href !== 'string') return '';
  const value = href.trim();
  if (!value) return '';
  if (
    value.startsWith('#')
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
  ) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return value;
    }
  } catch {
    return '';
  }
  return '';
}

export const markdownComponents = {
  table: ({ children, ...props }) => (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

export const shareMarkdownComponents = {
  ...markdownComponents,
  img: ({ src, alt }) => {
    if (typeof src !== 'string' || src.length > 12_000_000 || !DATA_IMAGE.test(src)) return null;
    return <img src={src} alt={typeof alt === 'string' ? alt : ''} referrerPolicy="no-referrer" />;
  },
  a: ({ href, children }) => {
    const safe = shareHref(href);
    if (!safe) return children;
    return (
      <a href={safe} rel="noreferrer noopener" target="_blank" referrerPolicy="no-referrer">
        {children}
      </a>
    );
  },
};
