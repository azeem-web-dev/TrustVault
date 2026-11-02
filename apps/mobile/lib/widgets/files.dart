import 'dart:io';

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../core/api.dart';
import '../core/offline_copies.dart';
import '../core/theme.dart';
import 'ui.dart';

/// Downloads through the API (so the read is audited exactly like the web,
/// and the copy is stamped with who and when), keeps it only encrypted
/// (THREATS.md V6) and opens it with the system viewer.
Future<void> downloadAndOpen(BuildContext context, {required String documentId, required int versionNo, required String apiPath, String fallbackName = 'document'}) async {
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    await OfflineCopies.save(documentId, versionNo, d.fileName, d.bytes);
    if (!context.mounted) return;
    await openSavedCopy(context, documentId: documentId, versionNo: versionNo);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  }
}

/// Opens the encrypted copy kept on this phone. Asks the server for its key
/// first: if access has ended, the copy is deleted and stays shut.
Future<void> openSavedCopy(BuildContext context, {required String documentId, required int versionNo}) async {
  try {
    final file = await OfflineCopies.openPlain(documentId, versionNo);
    final name = file.uri.pathSegments.last;
    if (!context.mounted) return;
    final r = await OpenFilex.open(file.path);
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
/// private storage, wiped at sign-out, and opened with the system viewer.
Future<void> downloadExportAndOpen(BuildContext context, String apiPath, {String fallbackName = 'export'}) async {
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    final dir = Directory('${(await getApplicationDocumentsDirectory()).path}/downloads');
    await dir.create(recursive: true);
    final safe = d.fileName.replaceAll(RegExp(r'[\/:*?"<>|]'), '_');
    final file = File('${dir.path}/$safe');
    await file.writeAsBytes(d.bytes, flush: true);
    if (!context.mounted) return;
    final r = await OpenFilex.open(file.path);
    if (context.mounted && r.type != ResultType.done) toast(context, 'Saved $safe', tone: Tone.blue);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  }
}
