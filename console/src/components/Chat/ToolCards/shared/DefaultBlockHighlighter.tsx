import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";

export default function DefaultBlockHighlighter({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  return (
    <SyntaxHighlighter
      language={language}
      style={oneDark}
      customStyle={{
        margin: 0,
        borderRadius: 0,
        padding: "10px 12px",
        fontSize: "12px",
        lineHeight: "1.6",
        maxHeight: "300px",
        overflowY: "auto",
      }}
      wrapLongLines
    >
      {content}
    </SyntaxHighlighter>
  );
}
