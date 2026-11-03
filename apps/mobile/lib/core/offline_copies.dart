import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'api.dart';
import 'local_copies.dart';

/// Files the app keeps, encrypted (THREATS.md V6).
///
/// A downloaded file is stored only as AES-256-GCM ciphertext under the
/// app's private storage. The key is never stored on the phone: it is
/// fetched from `POST /documents/:id/offline-key` every time the copy is
/// opened. That call needs READ access now, is audited, and the server
/// destroys the key when access drops, so after a revoke the copy on the
/// phone cannot be opened again, and it is deleted on the first refusal.
///
/// To show a file in another app it must be decrypted to a temporary file.
/// Those plain copies are deleted when the user comes back to TrustVault,
/// before the next open, and on sign-out (the gap is in THREATS.md V6).
class OfflineCopies {
  OfflineCopies._();

  static final _aes = AesGcm.with256bits();
  static const _magic = 'TVC1';

  /// `downloads/<document>/`: one folder per document (LocalCopies), so a
  /// 404 or sign-out removes the encrypted copy and any plain one together.
  static Future<Directory> _docDir(String documentId) async {
    final d = Directory('${(await LocalCopies.root()).path}/${LocalCopies.folderFor('/documents/$documentId/')}');
    await d.create(recursive: true);
    return d;
  }

  static Future<File> _file(String documentId, int versionNo) async => File('${(await _docDir(documentId)).path}/v$versionNo.tvc');

  static Future<SecretKey> _key(String documentId) async {
    final r = await Api.I.post('/documents/$documentId/offline-key') as Map;
    return SecretKey(base64Decode(r['key'] as String));
  }

  /// Encrypts and stores [bytes]; returns nothing the caller has to clean up.
  static Future<void> save(String documentId, int versionNo, String fileName, List<int> bytes) async {
    final key = await _key(documentId);
    final header = utf8.encode(jsonEncode({'documentId': documentId, 'versionNo': versionNo, 'fileName': fileName}));
    final box = await _aes.encrypt(bytes, secretKey: key, aad: header);
    final out = BytesBuilder(copy: false)
      ..add(ascii.encode(_magic))
      ..add((ByteData(4)..setUint32(0, header.length)).buffer.asUint8List())
      ..add(header)
      ..add(box.nonce)
      ..add(box.mac.bytes)
      ..add(box.cipherText);
    await (await _file(documentId, versionNo)).writeAsBytes(out.takeBytes(), flush: true);
  }

  static Future<bool> has(String documentId, int versionNo) async => (await _file(documentId, versionNo)).exists();

  /// Decrypts a stored copy into a short-lived plain file for the system viewer.
  /// Throws [ApiError] 404 when access has ended; the stored copy is then deleted.
  static Future<File> openPlain(String documentId, int versionNo) async {
    await wipeOpened();
    final file = await _file(documentId, versionNo);
    final SecretKey key;
    try {
      key = await _key(documentId);
    } on ApiError catch (e) {
      if (e.status == 404) await forget(documentId);
      rethrow;
    }
    final data = await file.readAsBytes();
    if (data.length < 8 || ascii.decode(data.sublist(0, 4)) != _magic) throw ApiError(0, 'This saved copy is damaged. Download it again.');
    final headerLen = ByteData.sublistView(data, 4, 8).getUint32(0);
    final header = data.sublist(8, 8 + headerLen);
    var at = 8 + headerLen;
    final nonce = data.sublist(at, at += 12);
    final mac = Mac(data.sublist(at, at += 16));
    final plain = await _aes.decrypt(SecretBox(data.sublist(at), nonce: nonce, mac: mac), secretKey: key, aad: header);
    final name = (jsonDecode(utf8.decode(header)) as Map)['fileName'] as String;
    final opened = Directory('${(await _docDir(documentId)).path}/opened');
    await opened.create(recursive: true);
    final out = File('${opened.path}/${LocalCopies.safeName(name)}');
    await out.writeAsBytes(plain, flush: true);
    return out;
  }

  /// Every stored copy of one document (access ended).
  static Future<void> forget(String documentId) => LocalCopies.removeFor(documentId);

  /// Plain copies handed to other apps.
  static Future<void> wipeOpened() async {
    try {
      final root = await LocalCopies.root();
      if (!await root.exists()) return;
      await for (final d in root.list()) {
        if (d is Directory) {
          final opened = Directory('${d.path}/opened');
          if (await opened.exists()) await opened.delete(recursive: true);
        }
      }
    } catch (_) {}
  }
}
