import { buildContainer, createApp } from './composition/container.js';
import { loadEnv, type Env } from './infrastructure/config/env.js';

/** The validated env, or undefined after naming the invalid variables, never their values. */
const readEnv = (): Env | undefined => {
  try {
    return loadEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid environment variables');
    return undefined;
  }
};

const env = readEnv();

if (env === undefined) {
  process.exitCode = 1;
} else {
  const port = env.PORT;
  createApp(buildContainer(env)).listen(port, (error) => {
    if (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.info(JSON.stringify({ event: 'api.listening', port }));
  });
}
