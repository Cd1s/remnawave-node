/// <reference path="../node_modules/@rspack/core/module.d.ts" />

declare const __RWNODE_VERSION__: string;

interface ImportMeta {
    readonly webpackHot?: {
        accept(): void;
        dispose(callback: () => void): void;
    };
}

declare module '@nestjs/swagger' {
    interface OpenAPIObject {
        components?: {
            schemas?: Record<string, unknown>;
        };
    }
}
