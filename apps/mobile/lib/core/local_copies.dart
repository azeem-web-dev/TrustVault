import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Decrypted copies of downloaded documents on the phone.
///
/// They live only in the app's private storage (`<app files>/downloads`,
/// never external or shared storage), one folder per document so a single
/// document's copies can be removed when the server says it is no longer
/// ours (revoked, expired, deleted). Everything goes on sign-out, together
/// with the temporary copies the file picker makes for uploads.
class LocalCopies {
  LocalCopies._();

  static Future<Directory> root() async => Directory('${(await getApplicationDocumentsDirectory()).path}/downloads');

  /// `/documents/<id>/download` and `/documents/<id>/versions/3/download`
  /// belong to document `<id>`; anything else (audit export) is "other".
  static String folderFor(String apiPath) {
    final m = RegExp(r'^/documents/([A-Za-z0-9_-]+)/').firstMatch(apiPath);
    return m?.group(1) ?? '_other';
  }

  /// A server-supplied file name reduced to one harmless path segment.
  static String safeName(String name) {
    var s = name.replaceAll(RegExp(r'[\\/:*?"<>|\x00-\x1f]'), '_').trim();
    if (s.isEmpty || s == '.' || s == '..') s = 'document';
    if (s.length > 120) s = s.substring(s.length - 120);
    return s;
  }

  static Future<File> save(String apiPath, String fileName, List<int> bytes) async {
    final dir = Directory('${(await root()).path}/${folderFor(apiPath)}');
    await dir.create(recursive: true);
    final file = File('${dir.path}/${safeName(fileName)}');
    await file.writeAsBytes(bytes, flush: true);
    return file;
  }

  /// Removes every local copy of one document.
  static Future<void> removeFor(String docId) async {
    try {
      final dir = Directory('${(await root()).path}/${folderFor('/documents/$docId/')}');
      if (await dir.exists()) await dir.delete(recursive: true);
    } catch (_) {}
  }

  /// Removes every local copy and temporary file (sign-out, session ended).
  static Future<void> wipeAll() async {
    try {
      final dir = await root();
      if (await dir.exists()) await dir.delete(recursive: true);
    } catch (_) {}
    try {
      final picked = Directory('${(await getTemporaryDirectory()).path}/file_picker');
      if (await picked.exists()) await picked.delete(recursive: true);
    } catch (_) {}
  }
}
