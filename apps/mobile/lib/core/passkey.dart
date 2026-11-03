import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';

import 'api.dart';

/// Passkeys through Android's Credential Manager (package `passkeys`).
///
/// The API sends standard WebAuthn options JSON and verifies the response
/// exactly as it does for the browser. Android reports the origin as
/// `android:apk-key-hash:<SHA-256 of our signing certificate>`, which the
/// API accepts only when it is listed in PASSKEY_ANDROID_ORIGINS; the RP id
/// stays vault.rayyanazeem.cloud, tied to this app by
/// /.well-known/assetlinks.json (THREATS.md S22). So a passkey made on the
/// website also works here, and the other way round.
class Passkeys {
  Passkeys._();
  static final _auth = PasskeyAuthenticator();

  /// Adds a passkey to the signed-in account. Returns the API's answer (it
  /// may carry a new session when this is the first factor).
  static Future<dynamic> register(String name) async {
    final options = await Api.I.post('/auth/mfa/passkeys/register/options') as Map;
    final response = await _guard(() => _auth.register(RegisterRequestType.fromJson(Map<String, dynamic>.from(options))));
    return Api.I.post('/auth/mfa/passkeys/register', {'response': response.toJson(), 'name': name});
  }

  /// Signs the assertion for this session's challenge and posts it to `path`
  /// (`/auth/mfa/passkeys/verify` at sign-in, `/auth/mfa/step-up` before a
  /// risky action).
  static Future<dynamic> assertTo(String path) async {
    final options = await Api.I.post('/auth/mfa/passkeys/options') as Map;
    final request = AuthenticateRequestType.fromJson(Map<String, dynamic>.from(options), preferImmediatelyAvailableCredentials: false);
    final response = await _guard(() => _auth.authenticate(request));
    return Api.I.post(path, {'response': response.toJson()});
  }

  /// Turns the platform's errors into the app's plain messages.
  static Future<T> _guard<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on PasskeyAuthCancelledException {
      throw ApiError(0, 'Cancelled');
    } on NoCredentialsAvailableException {
      throw ApiError(0, 'No passkey for this account on this phone. Use your authenticator code, or add a passkey from Account.');
    } on DomainNotAssociatedException {
      throw ApiError(0, 'This app is not yet linked to the website for passkeys. Use your authenticator code for now.');
    } on MissingGoogleSignInException {
      throw ApiError(0, 'Passkeys on Android need a Google account on this phone.');
    } on ExcludeCredentialsCanNotBeRegisteredException {
      throw ApiError(0, 'This phone already has a passkey for your account.');
    } on AuthenticatorException {
      throw ApiError(0, 'Passkeys are not available on this phone.');
    }
  }
}
