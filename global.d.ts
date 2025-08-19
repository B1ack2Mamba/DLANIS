// types/global.d.ts

// чтобы любой .json можно было импортить:
declare module '*.json';

// чтобы process.env.NEXT_PUBLIC_CLUSTER_URL не ругалось:
declare namespace NodeJS {
    interface ProcessEnv {
        NEXT_PUBLIC_CLUSTER_URL?: string;
    }
}
