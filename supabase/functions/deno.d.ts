declare namespace Deno {
  export interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    toObject(): Record<string, string>;
  }
  export const env: Env;
  export function serve(
    handler: (request: Request) => Response | Promise<Response>,
    options?: { port?: number; onListen?: (params: { port: number; hostname: string }) => void }
  ): void;
}

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
} | undefined;

declare module "@negrel/webpush" {
  export class ApplicationServer {
    static new(options: { contactInformation: string; vapidKeys: any }): Promise<ApplicationServer>;
    subscribe(subscription: PushSubscription): {
      pushTextMessage(
        text: string,
        options?: { ttl?: number; urgency?: Urgency; topic?: string }
      ): Promise<any>;
    };
  }
  export function importVapidKeys(jwk: any): Promise<any>;
  export class PushMessageError extends Error {
    response: { status: number };
    isGone(): boolean;
  }
  export enum Urgency {
    VeryLow = "very-low",
    Low = "low",
    Normal = "normal",
    High = "high",
  }
  export interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }
}
