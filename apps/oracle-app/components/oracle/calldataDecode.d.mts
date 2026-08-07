// Types for the calldata decoder.
//
// The logic lives in .mjs so a node:test suite can import it directly without a
// build step. This declaration keeps the pane fully typed.

export interface DecodedArg {
  name: string;
  type: string;
  value: string | boolean;
}

export type DecodedCalldata =
  | {
      ok: true;
      selector: string;
      signature: string;
      name: string;
      args: DecodedArg[];
      summary: string;
    }
  | {
      ok: false;
      selector: string | null;
      reason: string;
    };

export declare function decodeCalldata(data: unknown): DecodedCalldata;
export declare function describesRevoke(decoded: DecodedCalldata): boolean;
