# Admin SPA

ローカル開発・デプロイ手順（最小）

必要な環境変数（ビルド/実行）:
- `VITE_ADMIN_AUTHORITY` - Cognito Authority (例: https://cognito-idp.ap-northeast-1.amazonaws.com/<poolId>)
- `VITE_ADMIN_CLIENT_ID` - 管理用 Cognito アプリクライアントID
- `VITE_ADMIN_REDIRECT_URI` - 管理ページのコールバック URI (例: https://example.com/admin/auth/callback)
- `VITE_API_BASE_URL` - API Gateway ベース URL
- `VITE_ADMIN_GROUP_NAME` - 管理者グループ名（defaults to `admins`）

開発:
- ルートで `npm run dev:admin` を使って管理画面の開発サーバを起動します。

ビルド/デプロイ:
- `vite.admin.config.ts` を使い `vite build --config vite.admin.config.ts` でビルドします。
- ビルド成果物を S3 + CloudFront にデプロイしてください（既存の infra CDK を拡張することを推奨）。

注意:
- Lambda 側で Cognito Admin API を呼ぶため、Lambda に Cognito の Admin* 権限を付与し、環境変数 `USER_POOL_ID` と `ADMIN_GROUP_NAME` を設定してください。
