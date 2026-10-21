export interface PythonSelection {
  readonly id: string;
  readonly path: string;
  readonly executable: string;
  readonly label: string;
}
export interface DevelopmentEnvironment {
  readonly invocation: string;
  readonly executable: string;
  readonly prefix: string;
  readonly basePrefix: string;
  readonly version: string;
  readonly identity: string;
  readonly purelib: string;
  readonly platlib: string;
}
export interface SdkInspection {
  readonly environment: DevelopmentEnvironment;
  readonly installed?: { readonly version: string; readonly location: string; readonly inEnvironment: boolean };
}
export interface DevelopmentSnapshot {
  readonly resource: string;
  readonly selection: PythonSelection;
  readonly inspection: SdkInspection;
}
