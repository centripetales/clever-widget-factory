import { vi } from 'vitest';
import path from 'path';
import Module from 'module';

const mocksDir = path.resolve(import.meta.dirname, '__mocks__');

// Patch Node's module resolution to redirect /opt/nodejs/* to __mocks__/*
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('/opt/nodejs/')) {
    const moduleName = request.replace('/opt/nodejs/', '');
    return originalResolveFilename.call(this, path.join(mocksDir, moduleName + '.js'), parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
