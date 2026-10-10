import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
import subprocess
import shutil
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-game-images.py"
spec = importlib.util.spec_from_file_location("verify_game_images", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class GameImageVerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {"rootfs": {"diff_ids": ["sha256:" + "a" * 64]},
                       "created": "2026-09-30T00:00:00Z", "architecture": "amd64", "os": "linux"}

    def bundle(self, omitted=None, wrong_version=None, config=None):
        for index, repo in enumerate(verify.REQUIRED):
            if repo == omitted:
                continue
            tag = "17.4" if repo == verify.POSTGRES else "2134304-0-shipping"
            if repo == wrong_version:
                tag = "2124138-0-shipping"
            with tarfile.open(self.root / f"image-{index}.tar", "w") as archive:
                for name, obj in [("manifest.json", [{"RepoTags": [repo + ":" + tag], "Config": "config.json"}]),
                                  ("config.json", self.config if config is None else config)]:
                    data = json.dumps(obj).encode()
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))

    def loaded(self, _tag):
        return {"Id": "different-containerd-manifest-id", "RootFS": {"Layers": self.config["rootfs"]["diff_ids"]},
                "Created": self.config["created"], "Architecture": "amd64", "Os": "linux"}

    def test_complete_bundle_matches_loaded_images(self):
        self.bundle()
        images = verify.bundle_images(self.root)
        verify.verify_loaded(images, self.loaded)
        self.assertEqual(images[verify.WORLD][0], verify.WORLD + ":2134304-0-shipping")

    def test_empty_bundle_rejected(self):
        with self.assertRaisesRegex(ValueError, "No downloaded"):
            verify.bundle_images(self.root)

    def test_missing_db_utilities_rejected(self):
        self.bundle(omitted=verify.WORLD + "-db-utils")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            verify.bundle_images(self.root)

    def test_mixed_service_versions_rejected(self):
        self.bundle(wrong_version=verify.WORLD + "-gateway")
        with self.assertRaisesRegex(ValueError, "does not match"):
            verify.bundle_images(self.root)

    def test_stale_loaded_image_rejected(self):
        self.bundle()
        stale = self.loaded("")
        stale["RootFS"]["Layers"] = ["sha256:" + "b" * 64]
        with self.assertRaisesRegex(ValueError, "does not match"):
            verify.verify_loaded(verify.bundle_images(self.root), lambda _: stale)

    def test_missing_loaded_image_rejected(self):
        self.bundle()
        def missing(_):
            raise ValueError("Required image is not loaded locally")
        with self.assertRaisesRegex(ValueError, "not loaded locally"):
            verify.verify_loaded(verify.bundle_images(self.root), missing)

    def test_malformed_config_rejected(self):
        self.bundle(config={})
        with self.assertRaisesRegex(ValueError, "Invalid image configuration"):
            verify.bundle_images(self.root)

    def test_conflicting_world_images_rejected(self):
        self.bundle()
        with tarfile.open(self.root / "extra.tar", "w") as archive:
            for name, obj in [("manifest.json", [{"RepoTags": [verify.WORLD + ":9999999"], "Config": "config.json"}]),
                              ("config.json", self.config)]:
                data = json.dumps(obj).encode()
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            verify.bundle_images(self.root)

    def test_tag_file_preserved_when_bundle_verification_fails(self):
        self.tag_script_fixture("printf 'DUNE_WORLD_IMAGE_TAG=new\\n'; exit 1", False)

    def test_tags_published_from_bundle_not_highest_old_image(self):
        self.tag_script_fixture("printf 'DUNE_WORLD_IMAGE_TAG=2134304-0-shipping\\nDUNE_POSTGRES_IMAGE_TAG=17.4\\n'", True)

    def tag_script_fixture(self, docker_body, succeeds):
        scripts = self.root / "runtime/scripts"
        generated = self.root / "runtime/generated"
        scripts.mkdir(parents=True)
        generated.mkdir(parents=True)
        shutil.copy(SCRIPT.parent / "detect-image-tags.sh", scripts)
        shutil.copy(SCRIPT, scripts)
        tags = generated / "image-tags.env"
        tags.write_text("old-tags\n")
        docker = self.root / "docker"
        docker.write_text("#!/bin/sh\n" + docker_body + "\n")
        docker.chmod(0o755)
        import os
        result = subprocess.run(["bash", str(scripts / "detect-image-tags.sh"), "--from-bundle"],
                                cwd=self.root, env={**os.environ, "PATH": str(self.root) + ":" + os.environ["PATH"]},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, succeeds, result.stderr)
        self.assertEqual(tags.read_text(), "DUNE_WORLD_IMAGE_TAG=2134304-0-shipping\nDUNE_POSTGRES_IMAGE_TAG=17.4\n" if succeeds else "old-tags\n")
        self.assertEqual(list(generated.glob("*.tmp.*")), [])


if __name__ == "__main__":
    unittest.main()
