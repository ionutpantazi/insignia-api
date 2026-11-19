import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { type BackupStore, validateBackup } from "./backup.js";
import { errorCode, errorSummary, HttpError } from "./errors.js";

export interface AppDependencies {
  store: BackupStore;
  verifyIdToken(token: string): Promise<{ uid: string }>;
  logger: Pick<Console, "error">;
}

const invalidCredentialCodes = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

export function createApp({ store, verifyIdToken, logger }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.get("Authorization") ?? "");
    const token = bearer?.[1];
    if (!token) {
      throw new HttpError(401, "UNAUTHENTICATED", "A Firebase ID token is required.");
    }
    try {
      const { uid } = await verifyIdToken(token);
      res.locals.uid = uid;
    } catch (error) {
      if (invalidCredentialCodes.has(errorCode(error) ?? "")) {
        throw new HttpError(401, "UNAUTHENTICATED", "The Firebase ID token is invalid or expired.");
      }
      throw new HttpError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable.", {
        cause: error,
      });
    }
    next();
  };

  const requireJson: RequestHandler = (req, _res, next) => {
    if (!req.is("application/json")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json.");
    }
    if (req.get("Content-Encoding") && req.get("Content-Encoding")?.toLowerCase() !== "identity") {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Compressed request bodies are not supported.");
    }
    next();
  };

  app.put(
    "/v1/me/settings-backup",
    authenticate,
    requireJson,
    express.json({
      limit: 16 * 1024,
      strict: true,
      inflate: false,
      verify: (_req, _res, _body, encoding) => {
        if (encoding !== "utf-8") {
          throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use uncompressed UTF-8 JSON.");
        }
      },
    }),
    async (req, res) => {
      const body: unknown = req.body;
      if (!validateBackup(body)) {
        res.status(422).json({
          error: {
            code: "VALIDATION_FAILED",
            message: "The backup does not match schema version 1.",
            details: validateBackup.errors?.slice(0, 10).map((error) => ({
              path: error.instancePath || "/",
              keyword: error.keyword,
              message: error.message,
            })),
          },
        });
        return;
      }
      const uid: string = res.locals.uid;
      await store.save(uid, body);
      res.status(204).end();
    },
  );

  app.get("/v1/me/settings-backup", authenticate, async (_req, res) => {
    const uid: string = res.locals.uid;
    const stored = await store.get(uid);
    if (!stored) {
      throw new HttpError(404, "NO_BACKUP", "No settings backup exists for this account.");
    }
    if (!validateBackup(stored.backup)) {
      throw new Error("Stored backup failed schema validation.");
    }
    res.json(stored);
  });

  app.use((_req, _res, next) => {
    next(new HttpError(404, "NOT_FOUND", "This API route does not exist."));
  });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    let responseError: HttpError;
    if (error instanceof HttpError) {
      responseError = error;
    } else if (hasParserType(error, "entity.too.large")) {
      responseError = new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body must not exceed 16384 bytes.");
    } else if (hasParserType(error, "entity.parse.failed")) {
      responseError = new HttpError(400, "INVALID_JSON", "The request body must be valid JSON.");
    } else if (hasParserType(error, "charset.unsupported") || hasParserType(error, "encoding.unsupported")) {
      responseError = new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use uncompressed UTF-8 JSON.");
    } else if (hasParserType(error, "request.aborted") || hasParserType(error, "request.size.invalid")) {
      responseError = new HttpError(400, "INVALID_REQUEST", "The request body was incomplete.");
    } else {
      responseError = new HttpError(500, "INTERNAL_ERROR", "The request could not be completed.");
    }
    if (responseError.status >= 500) {
      logger.error("Backup API request failed", errorSummary(error));
    }
    if (responseError.status === 401) {
      res.set("WWW-Authenticate", 'Bearer realm="settings-backup"');
    }
    res.status(responseError.status).json({
      error: { code: responseError.code, message: responseError.message },
    });
  };
  app.use(handleError);
  return app;
}

function hasParserType(error: unknown, type: string): boolean {
  return typeof error === "object" && error !== null && "type" in error && error.type === type;
}
