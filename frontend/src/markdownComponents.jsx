import remarkGfm from 'remark-gfm';

export const remarkGfmPlugin = remarkGfm;

export const markdownComponents = {
  table: ({ children, ...props }) => (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};
