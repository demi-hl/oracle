# SafeERC20 template security notice

**Not a paid security-firm audit.**

This template is:
- fixed-supply ERC20
- Ownable2Step + pause
- no tax / blacklist / upgrade proxy
- covered by Foundry unit tests in `test/`

Before mainnet capital:
1. Keep or expand Foundry tests green
2. Run static analysis (Slither/Aderyn) if available
3. Book an independent Solidity auditor for any real TVL

Oracle only prepares unsigned deploys after the JS gate confirms `forge test` passes.
