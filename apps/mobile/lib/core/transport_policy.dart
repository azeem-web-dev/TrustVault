/// Which API addresses the app may talk to.
///
/// Release builds only ever use HTTPS. Debug and profile builds may use plain
/// HTTP, but only to a loopback address or the emulator's alias for the host
/// (10.0.2.2), so a developer can run against a local API or the fake API in
/// `integration_test/`. Anything else gets a reason string; null means allowed.
String? insecureOriginReason(String url, {required bool release}) {
  final uri = Uri.tryParse(url);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) return 'The server address is not valid.';
  if (uri.userInfo.isNotEmpty) return 'The server address must not contain a user name or password.';
  if (uri.scheme == 'https') return null;
  if (uri.scheme != 'http') return 'Only HTTPS server addresses are allowed.';
  if (release) return 'Refusing to connect over plain HTTP in a release build.';
  const local = {'localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'};
  if (!local.contains(uri.host)) return 'Plain HTTP is only allowed to this computer or the emulator host.';
  return null;
}
