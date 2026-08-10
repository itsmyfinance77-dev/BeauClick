#!/usr/bin/env bash
#
# Downloads official WordPress core from wordpress.org and copies ONLY
# wp-admin/, wp-includes/, and the root *.php/license/readme files into
# wordpress/ — never wp-content.
#
# Why this exists instead of a Composer package (johnpbloch/wordpress-core
# etc.): during initial setup, installing WP core through Composer's
# "wordpress-core" installer type did a full extraction over the existing
# `wordpress/` directory and silently deleted our hand-authored
# wp-content/plugins/beauclick-* code (recovered from git, but it should
# never be possible to lose uncommitted work this way). This script only
# ever touches the explicit core paths listed below.
#
set -euo pipefail

WP_VERSION=${1:-latest}
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/wordpress"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "Downloading WordPress ($WP_VERSION)..."
if [ "$WP_VERSION" = "latest" ]; then
	URL="https://wordpress.org/latest.zip"
else
	URL="https://wordpress.org/wordpress-$WP_VERSION.zip"
fi

curl -fsSL -o "$TMP_DIR/wordpress.zip" "$URL"

echo "Extracting..."
unzip -q "$TMP_DIR/wordpress.zip" -d "$TMP_DIR"
# wordpress.org's zip always extracts into a top-level "wordpress/" folder.
SRC="$TMP_DIR/wordpress"

echo "Copying core-only paths into $TARGET (wp-content is never touched)..."
rm -rf "$TARGET/wp-admin" "$TARGET/wp-includes"
cp -r "$SRC/wp-admin" "$TARGET/wp-admin"
cp -r "$SRC/wp-includes" "$TARGET/wp-includes"

for f in index.php license.txt readme.html wp-activate.php wp-blog-header.php \
	wp-comments-post.php wp-config-sample.php wp-cron.php wp-links-opml.php \
	wp-load.php wp-login.php wp-mail.php wp-settings.php wp-signup.php \
	wp-trackback.php xmlrpc.php; do
	cp "$SRC/$f" "$TARGET/$f"
done

echo "Done. wordpress/wp-content was not touched."
