import { apiService, getApiData } from '@/lib/apiService';

export async function fetchOrganizationMembers() {
  const response = await apiService.get('/organization_members');
  return getApiData(response) || [];
}

export async function fetchActions(viewShared?: string[]) {
  const params: Record<string, any> = {};
  if (viewShared && viewShared.length > 0) {
    params.view_shared = viewShared.join(',');
  }
  const response = await apiService.get('/actions', { params });
  return getApiData(response) || [];
}

export async function fetchActionScores(params?: { startDate?: string; endDate?: string }) {
  const queryParams: Record<string, string> = {};
  if (params?.startDate) {
    queryParams.start_date = params.startDate;
  }
  if (params?.endDate) {
    queryParams.end_date = params.endDate;
  }

  const response = await apiService.get('/analysis/analyses', {
    params: queryParams,
  });
  return getApiData(response) || [];
}

