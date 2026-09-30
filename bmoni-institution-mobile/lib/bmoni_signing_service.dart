import 'package:bmoni_embedded_sdk/bmoni_embedded_sdk.dart';

/// Device-side signing only. API credentials and BMONI REST calls remain server-side.
class ReachBmoniSigningService {
  Future<void> initialize() async {
    BmoniEmbeddedSdk.initialize(pinLength: 6, requirePin: true);
  }

  Future<String> ensureWallet() async {
    final has = await BmoniEmbeddedSdk.hasWallet();
    if (has) return (await BmoniEmbeddedSdk.walletAddress())!;
    return await BmoniEmbeddedSdk.initWallet();
  }

  Future<String> signOwnerProof(String challengeMessage, String pin) {
    return BmoniEmbeddedSdk.signMessage(challengeMessage, pin: pin);
  }

  Future<String> signPaymentHash(String hashHex, String pin) {
    return BmoniEmbeddedSdk.signTransactionHash(hashHex, pin: pin);
  }
}
