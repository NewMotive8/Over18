-- My AI: separate "she is finished" from "her photograph is finished".
--
-- Her opening photograph is a SECOND provider render and it takes ~53 seconds,
-- measured four times and immovable: there is no quality, step or model
-- parameter on the image endpoint, and resolution makes no difference (52s at
-- 1080x1920, 53s at 720x1280). Her character, by contrast, is drawn in ~15-19s
-- and needs nothing else to be talked to.
--
-- So `status` stops waiting for the picture. A companion becomes `ready` the
-- moment she is drawn, and this column carries the photograph's own progress.
-- Without it the web client cannot tell "her picture is coming" from "her
-- picture failed", and would either stop polling too early or poll for ever.
CREATE TYPE "public"."user_companion_portrait_status" AS ENUM('pending', 'ready', 'failed');

ALTER TABLE "user_companions"
  ADD COLUMN "portrait_status" "user_companion_portrait_status" NOT NULL DEFAULT 'pending';

-- Companions that already exist predate the column, and 'pending' would make
-- the client wait for a photograph that nobody is making. One that has a
-- picture is done; one that finished without a picture never gets one unless
-- her owner asks.
UPDATE "user_companions" SET "portrait_status" = 'ready' WHERE "image_path" IS NOT NULL;
UPDATE "user_companions" SET "portrait_status" = 'failed'
  WHERE "image_path" IS NULL AND "status" <> 'generating';
