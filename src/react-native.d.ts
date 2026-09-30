// The two React Native modules this library uses, typed as narrowly as it
// uses them, so the library builds without React Native installed. In an app
// the real module and its own types take over.
declare module "react-native" {
  interface Subscription {
    remove(): void;
  }
  export const Linking: {
    openURL(url: string): Promise<unknown>;
    addEventListener(type: "url", listener: (event: { url: string }) => void): Subscription;
  };
  export const AppState: {
    addEventListener(type: "change", listener: (state: string) => void): Subscription;
  };
}
