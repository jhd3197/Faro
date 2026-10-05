<?php
/* Plugin Name: Faro test items — a tiny REST CRUD collection for Faro's WordPress backend tests. */

// Mimic host hardening that blocks the users endpoints to stop user
// enumeration (seen on Plesk): a bare HTML 403 before WordPress answers.
// Faro must still connect without them.
$faro_uri = isset($_SERVER['REQUEST_URI']) ? urldecode($_SERVER['REQUEST_URI']) : '';
if (strpos($faro_uri, '/wp/v2/users') !== false && strpos($faro_uri, 'application-passwords') === false) {
    http_response_code(403);
    header('Content-Type: text/html');
    echo "<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>";
    exit;
}

add_action('rest_api_init', function () {
    $admin = function () { return current_user_can('manage_options'); };
    $all = function () { return get_option('faro_test_items', array('1' => array('id' => '1', 'title' => 'Contact', 'notifications' => array(array('to' => 'old@example.com'))))); };
    register_rest_route('faro-test/v1', '/items', array(
        array('methods' => 'GET', 'permission_callback' => $admin, 'callback' => function () use ($all) { return $all(); }),
        array('methods' => 'POST', 'permission_callback' => $admin, 'callback' => function ($r) use ($all) {
            $items = $all(); $id = (string) (max(array_map('intval', array_keys($items)) ?: array(0)) + 1);
            $item = $r->get_json_params(); $item['id'] = $id; $items[$id] = $item; update_option('faro_test_items', $items);
            return $item; }),
    ));
    register_rest_route('faro-test/v1', '/items/(?P<id>\d+)', array(
        array('methods' => 'GET', 'permission_callback' => $admin, 'callback' => function ($r) use ($all) {
            $items = $all(); return isset($items[$r['id']]) ? $items[$r['id']] : new WP_Error('nf', 'not found', array('status' => 404)); }),
        array('methods' => 'PUT', 'permission_callback' => $admin, 'callback' => function ($r) use ($all) {
            $items = $all(); $item = $r->get_json_params(); $item['id'] = $r['id']; $items[$r['id']] = $item; update_option('faro_test_items', $items); return $item; }),
        array('methods' => 'DELETE', 'permission_callback' => $admin, 'callback' => function ($r) use ($all) {
            $items = $all(); unset($items[$r['id']]); update_option('faro_test_items', $items); return array('deleted' => true); }),
    ));
});
