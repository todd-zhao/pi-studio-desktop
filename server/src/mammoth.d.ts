// Minimal type shim for mammoth (the package ships no TypeScript types).
declare module "mammoth" {
  interface ConvertOptions {
    buffer?: Buffer | ArrayBuffer;
    path?: string;
  }
  interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  function convertToHtml(options: ConvertOptions): Promise<ConvertResult>;
  const mammoth: { convertToHtml: typeof convertToHtml };
  export default mammoth;
}
