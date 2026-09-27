// esbuild text-loader imports for prompt templates
declare module '*.md' {
  const content: string;
  export default content;
}
