// Downloaded (decrypted) copies: where they go, and when they go away.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:trustvault/core/local_copies.dart';

import 'support/harness.dart';

void main() {
  late Harness h;
  setUp(() async => h = await Harness.create());
  tearDown(() async => h.dispose());

  test('copies are saved only in app-private storage, one folder per document', () async {
    final f = await LocalCopies.save('/documents/d-report/download', 'report.txt', [1, 2, 3]);
    expect(f.path.replaceAll(r'\', '/'), '${h.sandbox.files.path.replaceAll(r'\', '/')}/downloads/d-report/report.txt');
    final v = await LocalCopies.save('/documents/d-report/versions/2/download', 'report-v2.txt', [4]);
    expect(v.parent.path, f.parent.path);
    final other = await LocalCopies.save('/admin/audit/export?fromSeq=1', 'bundle.json', [5]);
    expect(other.parent.path.replaceAll(r'\', '/'), endsWith('/downloads/_other'));
    expect(h.sandbox.external.listSync(recursive: true), isEmpty, reason: 'nothing on shared/external storage');
    expect(h.sandbox.allFiles().every((p) => p.startsWith('files/downloads/')), isTrue, reason: '${h.sandbox.allFiles()}');
  });

  test('server-supplied file names cannot escape the downloads folder', () async {
    for (final evil in ['../../shared_prefs/x.xml', r'..\..\evil', '..', '.', '', '/etc/passwd', 'a\u0000b', 'C:\\x']) {
      final f = await LocalCopies.save('/documents/d-1/download', evil, [1]);
      String norm(String p) => p.replaceAll(r'\', '/');
      final root = norm((await LocalCopies.root()).absolute.path);
      expect(norm(f.parent.absolute.path), '$root/d-1', reason: evil);
      expect(f.uri.pathSegments.last, isNot(anyOf('', '.', '..')), reason: evil);
    }
    expect(LocalCopies.safeName('..'), 'document');
    expect(LocalCopies.safeName('../a'), '.._a');
    expect(LocalCopies.safeName('x' * 300).length, 120);
  });

  test('a document id from the path cannot escape either', () {
    expect(LocalCopies.folderFor('/documents/../download'), '_other');
    expect(LocalCopies.folderFor('/documents/abc-123_X/download'), 'abc-123_X');
    expect(LocalCopies.folderFor('/admin/audit/export'), '_other');
  });

  test('removeFor removes one document and leaves the others', () async {
    await LocalCopies.save('/documents/d-1/download', 'a.txt', [1]);
    final keep = await LocalCopies.save('/documents/d-2/download', 'b.txt', [2]);
    await LocalCopies.removeFor('d-1');
    expect(Directory('${(await LocalCopies.root()).path}/d-1').existsSync(), isFalse);
    expect(keep.existsSync(), isTrue);
    await LocalCopies.removeFor('does-not-exist'); // no throw
  });

  test('wipeAll removes copies (old flat layout too) and file-picker temp copies', () async {
    await LocalCopies.save('/documents/d-1/download', 'a.txt', [1]);
    final legacy = File('${(await LocalCopies.root()).path}/flat-old-layout.pdf')..writeAsBytesSync([9]);
    final picked = File('${h.sandbox.cache.path}/file_picker/1700000000/contract.pdf')..createSync(recursive: true);
    final unrelated = File('${h.sandbox.cache.path}/flutter_engine_cache.bin')..writeAsBytesSync([0]);
    await LocalCopies.wipeAll();
    expect(legacy.existsSync(), isFalse);
    expect(picked.existsSync(), isFalse);
    expect(await (await LocalCopies.root()).exists(), isFalse);
    expect(unrelated.existsSync(), isTrue, reason: 'only our own temp files are removed');
    await LocalCopies.wipeAll(); // idempotent
  });
}
