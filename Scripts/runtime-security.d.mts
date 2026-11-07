export function isLoopbackHost(hostname: string | undefined): boolean;
export function allowsInsecureLocalDevelopment(environment?: NodeJS.ProcessEnv): boolean;
export function adminAuthenticationRequired(environment?: NodeJS.ProcessEnv): boolean;
export function assertRuntimeSecurity(environment?: NodeJS.ProcessEnv): void;
export function developmentRuntime(arguments_: string[], environment?: NodeJS.ProcessEnv): {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
};
