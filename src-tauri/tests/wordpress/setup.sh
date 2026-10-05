#!/usr/bin/env bash
# Start a throwaway WordPress for the Plan 25 live tests and print the env
# they need. Real WordPress, not a mock: the REST index, Application Passwords,
# the media library and plugin toggling all come from core. The mu-plugin
# faro-test-items.php adds /faro-test/v1/items, a small CRUD collection that
# stands in for a plugin API such as Gravity Forms' /gf/v2/forms.
#
#   bash src-tauri/tests/wordpress/setup.sh          # start + print env
#   bash src-tauri/tests/wordpress/setup.sh down     # remove everything
#
# Then:
#   cargo test -p faro --lib live_wordpress_rest -- --ignored --nocapture
#   node scripts/verify-wordpress.mjs   (needs the app running, see its header)
set -euo pipefail

PORT="${WP_PORT:-8089}"
NET=faro-wp-test-net
DB=faro-wp-test-db
WP=faro-wp-test-wp
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="http://127.0.0.1:$PORT"
ADMIN_PW="FaroTest-Admin-2026!"

if [ "${1:-}" = "down" ]; then
  docker rm -f "$WP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed"
  exit 0
fi

PLUGIN="$HERE/faro-test-items.php"
command -v cygpath >/dev/null && PLUGIN="$(cygpath -w "$PLUGIN")"

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$WP" "$DB" >/dev/null 2>&1 || true
docker run -d --name "$DB" --network "$NET" \
  -e MARIADB_DATABASE=wp -e MARIADB_USER=wp -e MARIADB_PASSWORD=wp \
  -e MARIADB_ROOT_PASSWORD=root mariadb:11 >/dev/null
# WP_ENVIRONMENT_TYPE=local lets Application Passwords work over plain http.
MSYS_NO_PATHCONV=1 docker run -d --name "$WP" --network "$NET" -p "$PORT:80" \
  -e WORDPRESS_DB_HOST="$DB" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp \
  -e WORDPRESS_DB_NAME=wp \
  -e "WORDPRESS_CONFIG_EXTRA=define('WP_ENVIRONMENT_TYPE','local');" \
  -v "$PLUGIN:/var/www/html/wp-content/mu-plugins/faro-test-items.php" \
  wordpress:6.7-php8.3-apache >/dev/null

for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/wp-admin/install.php")" = 200 ] && break
  sleep 2
done

curl -s -o /dev/null -X POST "$URL/wp-admin/install.php?step=2" \
  --data-urlencode "weblog_title=Faro Test" --data-urlencode "user_name=admin" \
  --data-urlencode "admin_password=$ADMIN_PW" --data-urlencode "admin_password2=$ADMIN_PW" \
  --data-urlencode "pw_weak=1" --data-urlencode "admin_email=admin@example.test" \
  --data-urlencode "blog_public=0"

# Log in with a cookie, then mint an Application Password over REST.
JAR="$(mktemp)"
curl -s -c "$JAR" -b "$JAR" -o /dev/null "$URL/wp-login.php"
curl -s -c "$JAR" -b "$JAR" -o /dev/null -X POST "$URL/wp-login.php" \
  --data-urlencode "log=admin" --data-urlencode "pwd=$ADMIN_PW" \
  --data-urlencode "testcookie=1" -b "wordpress_test_cookie=WP%20Cookie%20check"
NONCE="$(curl -s -b "$JAR" "$URL/wp-admin/admin-ajax.php?action=rest-nonce")"
APP_PW="$(curl -s -b "$JAR" -H "X-WP-Nonce: $NONCE" -X POST \
  "$URL/?rest_route=/wp/v2/users/me/application-passwords" -d "name=faro-test" \
  | grep -o '"password":"[^"]*"' | cut -d'"' -f4)"
rm -f "$JAR"

[ -n "$APP_PW" ] || { echo "couldn't create an application password" >&2; exit 1; }
cat <<EOF
export FARO_WP_TEST_URL=$URL FARO_WP_TEST_USER=admin FARO_WP_TEST_PASSWORD='$APP_PW'
export WP_URL=$URL WP_USER=admin WP_APP_PASSWORD='$APP_PW'
EOF
