import { randomUUID } from "node:crypto";
import { type Express, type RequestHandler } from "express";
import { HttpError } from "./errors.js";
import { type ProfileStore, type ProfileVersion, isPublicRadioUrl, prepareProfile, profilePageSize, profileValidators } from "./profiles.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && idPattern.test(value);
}

function profileNotFound(): HttpError {
  return new HttpError(404, "PROFILE_NOT_FOUND", "No profile with that ID exists for this account.");
}

export function registerProfileRoutes(
  app: Express, store: ProfileStore, version: ProfileVersion, authenticate: RequestHandler, requireJson: RequestHandler, parseJson: RequestHandler,
) {
  const collection = `/v${version}/me/settings-profiles`;
  const validateProfile = profileValidators[version];
  app.get(collection, authenticate, async (req, res) => {
    const uid: string = res.locals.uid;
    const after = req.query.after;
    if (after !== undefined && !isProfileId(after)) {
      throw new HttpError(400, "INVALID_CURSOR", "The after cursor must be a profile ID from the list response.");
    }
    const rows = await store.list(uid, after ?? "", version);
    const profiles = rows.slice(0, profilePageSize);
    res.json({ profiles, nextCursor: rows[profilePageSize] ? rows[profilePageSize - 1]!.id : null });
  });

  app.get(`${collection}/:id`, authenticate, async (req, res) => {
    const uid: string = res.locals.uid;
    const { id } = req.params;
    if (!isProfileId(id)) throw profileNotFound();
    const stored = await store.get(uid, id, version);
    if (!stored) throw profileNotFound();
    if (!validateProfile(stored.payload)) throw new Error("Stored profile failed schema validation.");
    res.json({ ...stored.payload, id, updatedAt: stored.updatedAt });
  });

  for (const method of ["post", "put"] as const) {
    app[method](method === "post" ? collection : `${collection}/:id`, authenticate, requireJson, parseJson, async (req, res) => {
      const uid: string = res.locals.uid;
      const id = method === "post" ? randomUUID() : req.params.id;
      if (!isProfileId(id)) throw profileNotFound();
      const body: unknown = req.body;
      if (!validateProfile(body)) {
        res.status(422).json({
          error: {
            code: "VALIDATION_FAILED",
            message: `The profile does not match schema version ${version}.`,
            details: validateProfile.errors?.slice(0, 10).map((error) => ({
              path: error.instancePath || "/",
              keyword: error.keyword,
              message: error.message,
            })),
          },
        });
        return;
      }
      const url = body.settings.radio.serverUrl;
      if (url !== null && !isPublicRadioUrl(url)) {
        throw new HttpError(422, "INVALID_RADIO_URL", "Radio URL must be a valid HTTP(S) URL without credentials or a fragment.");
      }
      const payload = await prepareProfile(body);
      const updatedAt = new Date();
      const summary = { id, name: payload.name, updatedAt: updatedAt.toISOString() };
      if (method === "post") {
        await store.create(uid, id, payload, updatedAt);
        res.location(`${collection}/${id}`).status(201).json(summary);
      } else {
        if (!await store.overwrite(uid, id, payload, updatedAt)) throw profileNotFound();
        res.json(summary);
      }
    });
  }
}
