import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';

import '../core/api.dart';
import '../core/local_copies.dart';
import '../core/offline_copies.dart';
import '../core/theme.dart';
import 'ui.dart';

/// Test seam: how a saved copy is handed to the system viewer. Tests replace
/// it so no real viewer app is launched.
@visibleForTesting
Future<OpenResult> Function(String path) openFileWith = OpenFilex.open;

/// Downloads through the API (so the read is audited exactly like the web,
/// and the copy is stamped with who and when), keeps it only encrypted in
/// this document's private folder (THREATS.md V6) and opens it with the
/// system viewer. A 404 (revoked, expired, deleted) removes every copy of
/// the document kept on this phone.
///
/// A second tap while the same file is still downloading does nothing: each
/// download is audited and may use up a one-time approval.
Future<void> downloadAndOpen(BuildContext context, {required String documentId, required int versionNo, required String apiPath, String fallbackName = 'document'}) async {
  if (!_begin(apiPath)) return;
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    await OfflineCopies.save(documentId, versionNo, d.fileName, d.bytes);
    if (!context.mounted) return;
    await openSavedCopy(context, documentId: documentId, versionNo: versionNo);
  } catch (e) {
    // No longer ours (revoked, expired, deleted): drop any copy saved earlier.
    if (e is ApiError && e.status == 404) await LocalCopies.removeFor(documentId);
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  } finally {
    _end(apiPath);
  }
}

/// API paths being downloaded right now. Buttons listen to it to show a
/// spinner and stay disabled until their download finishes.
final ValueNotifier<Set<String>> downloadsInFlight = ValueNotifier(const {});

bool isDownloading(String apiPath) => downloadsInFlight.value.contains(apiPath);

bool _begin(String apiPath) {
  if (isDownloading(apiPath)) return false;
  downloadsInFlight.value = {...downloadsInFlight.value, apiPath};
  return true;
}

void _end(String apiPath) {
  downloadsInFlight.value = {...downloadsInFlight.value}..remove(apiPath);
}

/// Rebuilds [builder] with whether [apiPath] is downloading right now.
class DownloadState extends StatelessWidget {
  const DownloadState({super.key, required this.apiPath, required this.builder});
  final String apiPath;
  final Widget Function(BuildContext context, bool downloading) builder;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<Set<String>>(
    valueListenable: downloadsInFlight,
    builder: (context, set, _) => builder(context, set.contains(apiPath)),
  );
}

/// Opens the encrypted copy kept on this phone. Asks the server for its key
/// first: if access has ended, the copy is deleted and stays shut.
Future<void> openSavedCopy(BuildContext context, {required String documentId, required int versionNo}) async {
  try {
    final file = await OfflineCopies.openPlain(documentId, versionNo);
    final name = file.uri.pathSegments.last;
    if (!context.mounted) return;
    final r = await openFileWith(file.path);
    if (!context.mounted) return;
    if (r.type == ResultType.done) {
      toast(context, 'Opened $name');
    } else if (r.type == ResultType.noAppToOpen) {
      await OfflineCopies.wipeOpened();
      if (context.mounted) toast(context, 'Saved $name (encrypted). No app on this phone opens this file type.', tone: Tone.amber);
    } else {
      toast(context, 'Saved $name (encrypted)', tone: Tone.blue);
    }
  } on ApiError catch (e) {
    if (!context.mounted) return;
    toast(context, e.status == 404 ? 'Your access to this document has ended. The copy on this phone was deleted.' : e.message, tone: Tone.red);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e, 'Could not open the saved copy'), tone: Tone.red);
  }
}

/// Not a document (the audit evidence bundle): saved as it is in the app's
/// private storage (`downloads/_other`), wiped at sign-out, and opened with
/// the system viewer.
Future<void> downloadExportAndOpen(BuildContext context, String apiPath, {String fallbackName = 'export'}) async {
  if (!_begin(apiPath)) return;
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    final file = await LocalCopies.save(apiPath, d.fileName, d.bytes);
    final safe = LocalCopies.safeName(d.fileName);
    if (!context.mounted) return;
    final r = await openFileWith(file.path);
    if (context.mounted && r.type != ResultType.done) toast(context, 'Saved $safe', tone: Tone.blue);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  } finally {
    _end(apiPath);
  }
}
