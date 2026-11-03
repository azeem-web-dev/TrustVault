// The whole app against the fake API: sign-in, second factor, open and
// download a document, then revocation, share expiry, session expiry and
// sign-out, checking the screen and the phone's storage after each step.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trustvault/core/api.dart';
import 'package:trustvault/core/session.dart';
import 'package:trustvault/main.dart' show navigatorKey;

import 'support/app.dart';
import 'support/fake_api.dart';
import 'support/harness.dart';

void main() {
  late Harness h;
  setUp(() async {
    h = await Harness.create();
    WidgetController.hitTestWarningShouldBeFatal = true;
  });
  tearDown(() async => h.dispose());

  Future<void> tap(WidgetTester tester, Finder f) async {
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.tap(f);
  }

  Future<Session> signInThroughUi(WidgetTester tester) async {
    final s = await pumpApp(tester);
    expect(find.text('Welcome back'), findsOneWidget);
    await tester.enterText(find.byType(TextFormField).at(0), h.api.viewer.email);
    await tester.enterText(find.byType(TextFormField).at(1), h.api.viewer.password);
    await tap(tester, find.text('Sign in'));
    await settle(tester);
    // Second factor prompt: nothing else is reachable yet.
    expect(find.text('Confirm it’s you'), findsOneWidget);
    expect(s.mfaPending, isTrue);
    await tester.enterText(find.byType(TextField).last, FakeTrustVaultApi.totpCode);
    await tester.pump();
    await tap(tester, find.text('Verify'));
    await settle(tester);
    expect(s.mfaPending, isFalse);
    expect(find.text('Quarterly report'), findsWidgets);
    return s;
  }

  Future<void> openReport(WidgetTester tester) async {
    await tap(tester, find.text('Quarterly report').first);
    await settle(tester);
  }

  Future<File> downloadReport(WidgetTester tester) async {
    final btn = find.textContaining('Download  ·');
    final before = h.openedFiles.length;
    await tap(tester, btn);
    for (var i = 0; i < 20 && h.openedFiles.length == before; i++) {
      await settle(tester, rounds: 2);
    }
    expect(h.openedFiles.length, before + 1, reason: 'the system viewer should have been asked to open the copy');
    return File(h.openedFiles.last);
  }

  Future<void> back(WidgetTester tester) async {
    navigatorKey.currentState!.pop();
    await settle(tester);
  }

  testWidgets('wrong second-factor code keeps the user on the MFA screen', (tester) async {
    await pumpApp(tester);
    await tester.enterText(find.byType(TextFormField).at(0), h.api.viewer.email);
    await tester.enterText(find.byType(TextFormField).at(1), h.api.viewer.password);
    await tap(tester, find.text('Sign in'));
    await settle(tester);
    await tester.enterText(find.byType(TextField).last, '000000');
    await tester.pump();
    await tap(tester, find.text('Verify'));
    await settle(tester);
    expect(find.text('That code is not right'), findsOneWidget);
    expect(find.text('Quarterly report'), findsNothing);
    await drainToasts(tester);
  });

  testWidgets('download saves a private copy; revoke → next open refused and the copy is gone', (tester) async {
    await signInThroughUi(tester);
    await openReport(tester);
    final copy = await downloadReport(tester);
    expect(copy.existsSync(), isTrue);
    expect(copy.path.replaceAll(r'\', '/'), contains('/files/downloads/d-report/'));
    expect(h.sandbox.anyFileContains('TV-SECRET-PAYLOAD'), isTrue);
    await back(tester);

    h.api.revoke('d-report', h.api.viewer.id);
    await openReport(tester);
    expect(find.text('Nothing to see here'), findsOneWidget);
    expect(copy.existsSync(), isFalse);
    expect(h.sandbox.anyFileContains('TV-SECRET-PAYLOAD'), isFalse, reason: 'no plaintext of a revoked document stays on the phone');
    await drainToasts(tester);
  });

  testWidgets('a refused download (revoked while the page was open) removes the earlier copy', (tester) async {
    await signInThroughUi(tester);
    await openReport(tester);
    final copy = await downloadReport(tester);
    h.api.revoke('d-report', h.api.viewer.id);
    final btn = find.textContaining('Download  ·');
    await tap(tester, btn);
    await until(tester, () => !copy.existsSync());
    expect(copy.existsSync(), isFalse);
    expect(h.openedFiles, hasLength(1), reason: 'nothing new was opened');
    await drainToasts(tester);
  });

  testWidgets('an expired share behaves like a revoked one', (tester) async {
    await signInThroughUi(tester);
    await openReport(tester);
    final copy = await downloadReport(tester);
    await back(tester);
    h.api.expireShare('d-report', h.api.viewer.id);
    await openReport(tester);
    expect(find.text('Nothing to see here'), findsOneWidget);
    expect(copy.existsSync(), isFalse);
    await drainToasts(tester);
  });

  testWidgets('session ended on the server → back to sign-in, everything local wiped', (tester) async {
    final s = await signInThroughUi(tester);
    await openReport(tester);
    await downloadReport(tester);
    // Ended on the server (expiry, password changed on the web, deactivated)
    // while the document is on screen; the next tap gets a 401.
    h.api.endAllSessions();
    await tap(tester, find.textContaining('Download  ·'));
    await until(tester, () => s.user == null && find.text('Welcome back').evaluate().isNotEmpty);
    await settle(tester);
    expect(s.user, isNull);
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Quarterly report'), findsNothing);
    expect(h.secure, isEmpty);
    expect(Api.I.hasSession, isFalse);
    // Sync I/O only here: async file I/O never completes under the widget-test clock.
    expect(Directory('${h.sandbox.files.path}/downloads').existsSync(), isFalse);
    await drainToasts(tester);
  });

  testWidgets('sign-out from the account menu wipes the phone', (tester) async {
    await signInThroughUi(tester);
    await openReport(tester);
    await downloadReport(tester);
    await back(tester);
    await tester.tap(find.byTooltip('Account menu'));
    await settle(tester);
    await tester.tap(find.text('Sign out').last);
    await settle(tester, rounds: 12);
    expect(find.text('Welcome back'), findsOneWidget);
    expect(h.secure, isEmpty);
    expect(h.api.sessions, isEmpty);
    expect(h.sandbox.anyFileContains('TV-SECRET-PAYLOAD'), isFalse);
    await drainToasts(tester);
  });
}
